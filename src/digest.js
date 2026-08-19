import fs from "node:fs";
import path from "node:path";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const band = (s) => (s >= 85 ? "#2E6B4C" : s >= 75 ? "#4a6b2e" : "#8E6B2C");

export function renderText(jobs, meta) {
  if (!jobs.length) return `No roles cleared the bar today.\n\nScanned ${meta.scanned} postings from ${meta.sources} sources. Nothing scored ${meta.threshold}+.\nThat is a real result, not a failure — an empty digest beats a padded one.\n`;
  return [
    `${jobs.length} role${jobs.length === 1 ? "" : "s"} worth a look — from ${meta.scanned} postings scanned.`,
    "",
    ...jobs.flatMap((j, i) => [
      `${i + 1}. [${j.score}] ${j.title} — ${j.company}`,
      `   ${j.location || "location not stated"}${j.salaryText ? ` · ${j.salaryText}` : ""}${j.ageDays !== null ? ` · ${j.ageDays}d old` : ""}`,
      `   Why: ${j.reason}`,
      j.against ? `   Against: ${j.against}` : "",
      `   ${j.url}`,
      "",
    ]),
  ].filter((l) => l !== "").join("\n");
}

export function renderHTML(jobs, meta) {
  const rows = jobs.map((j) => `
    <tr><td style="padding:18px 0;border-bottom:1px solid #C6C6B8">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font:700 17px/1.3 -apple-system,Segoe UI,Arial,sans-serif;color:#191B18">
          <a href="${esc(j.url)}" style="color:#191B18;text-decoration:none">${esc(j.title)}</a>
        </td>
        <td align="right" style="font:600 15px/1 ui-monospace,Menlo,monospace;color:${band(j.score)};white-space:nowrap;padding-left:12px">${j.score}</td>
      </tr></table>
      <div style="font:500 13px/1.5 ui-monospace,Menlo,monospace;color:#5B6058;margin-top:5px">
        ${esc(j.company)} · ${esc(j.location || "location not stated")}${j.salaryText ? ` · ${esc(j.salaryText)}` : ""}${j.ageDays !== null ? ` · ${j.ageDays}d` : ""}
      </div>
      <div style="font:400 14px/1.55 Georgia,serif;color:#191B18;margin-top:9px">${esc(j.reason)}</div>
      ${j.against ? `<div style="font:400 13px/1.5 Georgia,serif;color:#8E3B2C;margin-top:5px">Against: ${esc(j.against)}</div>` : ""}
      <div style="margin-top:10px">
        <a href="${esc(j.url)}" style="font:500 12px/1 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:#2E6B4C;text-decoration:none;border:1px solid #2E6B4C;padding:7px 12px;display:inline-block">Open posting →</a>
      </div>
    </td></tr>`).join("");

  const emptyState = `<tr><td style="padding:28px 0;font:400 15px/1.6 Georgia,serif;color:#5B6058">
      Nothing cleared ${meta.threshold} today. Scanned ${meta.scanned} postings across ${meta.sources} sources.
      <br><br>An empty digest beats a padded one — this is the filter working, not failing.</td></tr>`;

  return `<!doctype html><html><body style="margin:0;padding:0;background:#EEEDE3">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#EEEDE3;padding:28px 14px">
    <tr><td align="center">
      <table width="100%" style="max-width:620px" cellpadding="0" cellspacing="0">
        <tr><td style="border-top:4px solid #191B18;padding-top:18px">
          <div style="font:500 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.16em;text-transform:uppercase;color:#8A8F84">Shortlist · ${esc(meta.date)}</div>
          <div style="font:800 30px/1.05 -apple-system,Segoe UI,Arial,sans-serif;color:#191B18;letter-spacing:-.02em;margin-top:7px;text-transform:uppercase">${jobs.length} role${jobs.length === 1 ? "" : "s"} worth a look</div>
          <div style="font:400 14px/1.5 Georgia,serif;color:#5B6058;margin-top:7px">
            ${meta.scanned} postings scanned · ${meta.filtered} passed filters · ${meta.llmScored} read in full
          </div>
        </td></tr>
        ${jobs.length ? rows : emptyState}
        <tr><td style="padding-top:20px;border-top:1px solid #191B18;font:400 11px/1.5 ui-monospace,Menlo,monospace;color:#8A8F84">
          Scored by ${esc(meta.model)} · run cost ${meta.cost}<br>
          Reply to this email with nothing — it is a one-way digest. Mark status with <code>npm run list</code>.
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

/**
 * Local delivery. The primary surface — a bookmarkable file that does not depend on
 * any third-party account, sending domain, or reputation.
 */
export function writeDigestFiles(jobs, meta) {
  const dir = path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  const html = renderHTML(jobs, meta);
  const dated = path.join(dir, `digest-${new Date().toISOString().slice(0, 10)}.html`);
  const latest = path.join(dir, "digest-latest.html");
  fs.writeFileSync(dated, html);
  fs.writeFileSync(latest, html);
  return { dated, latest };
}

export function digestSubject(jobs) {
  return jobs.length
    ? `${jobs.length} role${jobs.length === 1 ? "" : "s"} worth a look — top match ${jobs[0].score}`
    : "No roles cleared the bar today";
}

export async function sendDigest(jobs, meta, mailer) {
  return mailer.send({
    subject: digestSubject(jobs),
    html: renderHTML(jobs, meta),
    text: renderText(jobs, meta),
  });
}
