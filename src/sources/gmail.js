import { ImapFlow } from "imapflow";

/**
 * LinkedIn coverage, without scraping LinkedIn.
 *
 * LinkedIn has no public jobs API and blocks crawlers, so the only legitimate way in
 * is the one they already offer: saved-search alert emails. You create the alerts,
 * LinkedIn mails them to you, and this reads your own inbox over IMAP.
 *
 * Read-only. It opens the mailbox in readonly mode, touches nothing, and only looks at
 * messages from LinkedIn's job-alert sender.
 */

const ALERT_SENDERS = [
  "jobalerts-noreply@linkedin.com",
  "jobs-noreply@linkedin.com",
  "jobs-listings@linkedin.com",
];

// `&middot;` matters more than it looks: it is the separator between company and
// location in every LinkedIn card, so leaving it encoded merges the two fields.
const NAMED = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'",
  middot: "·", bull: "•", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘",
};

const decodeEntities = (s) =>
  s
    .replace(/&([a-z]+|#\d+);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));

const clean = (s) =>
  decodeEntities(
    String(s || "")
      .replace(/<[^>]*>/g, " ")
      // Reading a fixed-width window past the anchor usually cuts mid-tag, leaving an
      // unclosed `<table cell` that the tag pattern above cannot match.
      .replace(/<[^>]*$/, " ")
  )
    .replace(/\s+/g, " ")
    .trim();

/** Quoted-printable: soft line breaks first, then =XX byte escapes. */
function decodeQuotedPrintable(body) {
  const joined = body.replace(/=(?:\r\n|\n|\r)/g, "");
  const bytes = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === "=" && /^[0-9a-f]{2}$/i.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(joined[i], "utf8"));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Return the decoded text/html part of a raw MIME message.
 *
 * LinkedIn sends multipart/alternative with the HTML quoted-printable encoded, so the
 * raw source contains `=3D` for every `=` and soft breaks mid-attribute. Matching hrefs
 * against the raw bytes finds nothing.
 */
export function extractHtml(raw) {
  const source = String(raw);
  const boundary = source.match(/boundary="?([^"\s;]+)"?/i)?.[1];
  const parts = boundary ? source.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)) : [source];

  let best = "";
  for (const part of parts) {
    const split = part.indexOf("\r\n\r\n") >= 0 ? part.indexOf("\r\n\r\n") + 4 : part.indexOf("\n\n") + 2;
    if (split <= 1) continue;
    const headers = part.slice(0, split).toLowerCase();
    if (!headers.includes("text/html")) continue;

    const body = part.slice(split);
    const decoded = headers.includes("base64")
      ? Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8")
      : headers.includes("quoted-printable")
        ? decodeQuotedPrintable(body)
        : body;
    if (decoded.length > best.length) best = decoded;
  }
  // A message that never declared a text/html part may still be plain HTML.
  return best || source;
}

/** Strip LinkedIn's tracking wrapper down to the canonical public posting URL. */
export function canonicalJobUrl(href) {
  const id = href.match(/\/jobs\/view\/(\d+)/)?.[1];
  return id ? `https://www.linkedin.com/jobs/view/${id}/` : null;
}

/**
 * Pull job cards out of a LinkedIn alert email.
 *
 * The markup changes without notice, so this leans on the one stable thing — the
 * /jobs/view/<id> link — and reads the card's text around it. A card that yields no
 * title is dropped rather than guessed at.
 */
export function parseLinkedInAlert(html, sentAt = null) {
  const out = new Map();
  const anchor = /<a\b[^>]*href=["']([^"']*\/jobs\/view\/\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let m;
  while ((m = anchor.exec(html))) {
    const url = canonicalJobUrl(m[1]);
    const title = clean(m[2]);
    if (!url || !title || title.length < 3) continue;
    // "View job", "Apply now" and friends are buttons on the same card, not titles.
    if (/^(view|apply|see|show)\b/i.test(title)) continue;
    if (out.has(url)) continue;

    // The company and location sit in the card body between this link and the next.
    const after = html.slice(m.index + m[0].length, m.index + m[0].length + 1200);
    const lines = clean(after.split(/<a\b/i)[0]).split(/·|\||•/).map((s) => s.trim()).filter(Boolean);

    out.set(url, {
      sourceId: url.match(/(\d+)/)[1],
      company: lines[0] || "",
      title,
      location: lines[1] || "",
      url,
      // The alert email's own date. Not the true posting date, but a hard upper bound
      // on age — without it these rows carry no date at all and skip the freshness gate
      // entirely, so a month-old alert kept surfacing as if it were new.
      postedAt: sentAt,
      description: "",
      salaryText: "",
      tags: [],
      remoteHint: /remote/i.test(lines.join(" ")) ? true : null,
    });
  }
  return [...out.values()];
}

/** Newest-first search window, in days. */
const since = (days) => new Date(Date.now() - days * 86400000);

export async function fetchGmailAlerts({
  env = process.env,
  days = 7,
  mailbox = "INBOX",
  log = () => {},
  clientFactory,
} = {}) {
  const user = env.GMAIL_USER;
  const pass = (env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
  if (!user || !pass) {
    log("  gmail".padEnd(30) + "SKIPPED (no GMAIL_USER / GMAIL_APP_PASSWORD)");
    return [];
  }

  const client =
    clientFactory?.() ??
    new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: { user, pass },
      logger: false,
    });

  const jobs = [];
  let messages = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      for (const sender of ALERT_SENDERS) {
        const uids = await client.search({ from: sender, since: since(days) }, { uid: true });
        if (!uids?.length) continue;
        for await (const msg of client.fetch(uids, { source: true, envelope: true }, { uid: true })) {
          messages += 1;
          const sentAt = msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null;
          jobs.push(...parseLinkedInAlert(extractHtml(msg.source.toString("utf8")), sentAt));
        }
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    log("  gmail".padEnd(30) + `SKIPPED (${err.message})`);
    return [];
  } finally {
    await client.logout().catch(() => {});
  }

  // The same vacancy appears in every daily alert until it closes. Keep the most
  // recent sighting: a job still being advertised today is not a month old.
  const byUrl = new Map();
  for (const j of jobs) {
    const prev = byUrl.get(j.url);
    if (!prev || (j.postedAt || "") > (prev.postedAt || "")) byUrl.set(j.url, j);
  }
  const unique = [...byUrl.values()];
  log("  gmail/linkedin".padEnd(30) + `${unique.length} jobs (${messages} alert emails)`);
  return unique.map((j) => ({ ...j, source: "linkedin-alerts", tier: "feed", companyTags: [] }));
}
