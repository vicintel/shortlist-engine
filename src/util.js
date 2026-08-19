import crypto from "node:crypto";

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  mdash: "—", ndash: "–", hellip: "…", bull: "•",
};

/** Strip HTML to readable plain text. Job descriptions arrive as HTML from most sources. */
export function toText(html) {
  if (!html) return "";
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m)
    .replace(/[ \t ]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

export const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Stable identity for a posting. The same role listed on an ATS and mirrored by an
 * aggregator must collapse to one record, so the hash deliberately excludes the
 * source — company + title + location is the identity.
 */
export function jobHash({ company, title, location }) {
  // Punctuation becomes a space, not nothing: stripping it outright made
  // "Full-Stack Engineer" hash as "fullstack" while "Full Stack Engineer" stayed
  // "full stack", so the same role listed two ways never collapsed.
  const cleanTitle = norm(title).replace(/[^a-z0-9]+/g, " ").trim();
  const key = [norm(company), cleanTitle, norm(location).split(/[,(]/)[0].trim()].join("|");
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export const daysAgo = (iso) => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
};

export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Minimum-interval scheduler. Free LLM tiers are rate-limited per minute, so the
 * constraint is requests-per-minute rather than money — bursting just converts
 * every call into a retry.
 */
export function rateLimiter(rpm) {
  const interval = rpm > 0 ? 60000 / rpm : 0;
  let next = 0;
  return async function throttle() {
    if (!interval) return;
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + interval;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  };
}

const REQUIREMENT_MARKERS = [
  "requirement", "qualification", "you have", "you'll have", "you will have",
  "you bring", "must have", "should have", "we're looking for", "we are looking for",
  "what you'll need", "what you need", "experience with", "years of", "proficien",
  "familiar with", "skills", "nice to have", "bonus", "preferred", "ideal candidate",
  "you are", "you'll be", "responsibilities", "what you'll do", "tech stack",
];

/**
 * Trim a posting to a token budget without losing the part that matters.
 *
 * Blunt head-truncation cut the requirements section off 53% of postings — the
 * company blurb goes first, so the qualifications routinely sit past the cap. This
 * keeps the opening for context, then prefers requirement-bearing paragraphs from
 * the rest, and reassembles them in their original order.
 */
export function fitToBudget(text, max = 12000) {
  const body = String(text ?? "");
  if (body.length <= max) return body;

  const paras = body.split(/\n{2,}/);
  const headBudget = Math.floor(max * 0.45);
  const kept = new Set();
  let used = 0;

  for (let i = 0; i < paras.length && used + paras[i].length <= headBudget; i++) {
    kept.add(i);
    used += paras[i].length + 2;
  }

  const scored = paras
    .map((p, i) => ({ i, p, hits: REQUIREMENT_MARKERS.filter((m) => p.toLowerCase().includes(m)).length }))
    .filter((x) => !kept.has(x.i) && x.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.p.length - b.p.length);

  for (const { i, p } of scored) {
    if (used + p.length > max) continue;
    kept.add(i);
    used += p.length + 2;
  }

  const order = [...kept].sort((a, b) => a - b);
  const out = [];
  let prev = -1;
  for (const i of order) {
    if (prev >= 0 && i > prev + 1) out.push("[…]");
    out.push(paras[i]);
    prev = i;
  }
  return out.join("\n\n");
}

/** Fetch JSON with a timeout. Adapters never throw upward — a dead source is skipped, not fatal. */
export async function getJSON(url, { timeout = 20000 } = {}) {
  const res = await fetch(url, {
    headers: { "user-agent": "shortlist/0.1 (personal job search)", accept: "application/json" },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}
