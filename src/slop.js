/**
 * Screens generated text for the standard tells of machine writing.
 *
 * Based on Wikipedia's "Signs of AI writing". This matters commercially, not just
 * stylistically: Buffer's application form states outright that it screens for
 * "authentic responses… not polished or AI-generated answers".
 *
 * It flags candidates for a human to judge. It is not a verdict — a factual
 * contrast reads the same as a rhetorical one to a regular expression.
 */

export const VOCAB = [
  "robust", "leverage", "seamless", "showcase", "underscore", "delve", "crucial",
  "pivotal", "meticulous", "testament", "tapestry", "foster", "garner", "bolster",
  "vibrant", "intricate", "cutting-edge", "groundbreaking", "renowned", "boasts",
  "interplay", "enduring", "multifaceted", "holistic", "synergy", "paradigm",
  "proven track record", "ideal candidate", "strong match", "diverse array",
  "passionate about", "thrilled to", "excited to", "delighted to",
];

export const PATTERNS = [
  { id: "not-only-but-also", re: /not only\b[^.]{0,80}\bbut also\b/gi,
    note: "the most recognisable tell of the lot" },
  { id: "its-not-x-its-y", re: /\bit'?s not\b[^.]{0,60},\s*it'?s\b/gi,
    note: "rhetorical reversal" },
  { id: "rather-than-opener", re: /(^|[.!?]\s+)rather than\b[^.]{0,70}?,\s*(i|he)\b/gi,
    note: "opening a sentence on the contrast; fine mid-sentence as plain fact" },
  { id: "verb-dodge", re: /\b(serves as|stands as|functions as|positions (him|me) as|marks a turning)\b/gi,
    note: "avoiding the verb 'is'" },
  { id: "tacked-participle", re: /,\s+(highlighting|underscoring|emphasizing|ensuring|reflecting|symbolizing|contributing to|demonstrating|showcasing|solidifying|cementing)\b/gi,
    note: "participle bolted on to manufacture significance" },
  { id: "significance-claim", re: /\b(a testament to|speaks to (my|his)|underscores (my|his)|highlights (my|his) (deep|strong|extensive))\b/gi,
    note: "telling the reader it matters instead of showing it" },
];

const sentencesOf = (text) => text.split(/(?<=[.!?])\s+/).filter(Boolean);

export function checkSlop(text) {
  const findings = [];
  const body = String(text ?? "");

  for (const { id, re, note } of PATTERNS) {
    for (const m of body.matchAll(re)) {
      findings.push({ kind: id, note, match: m[0].trim().replace(/\s+/g, " ").slice(0, 120) });
    }
  }

  for (const word of VOCAB) {
    const re = new RegExp(`\\b${word.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "gi");
    for (const m of body.matchAll(re)) {
      const sentence = sentencesOf(body).find((s) => s.includes(m[0])) || "";
      findings.push({ kind: "vocab", note: `"${m[0]}"`, match: sentence.trim().replace(/\s+/g, " ").slice(0, 120) });
    }
  }

  const emDashes = (body.match(/—/g) || []).length;
  if (emDashes > 1) {
    findings.push({ kind: "em-dashes", note: `${emDashes} em dashes`, match: "prefer full stops; one is plenty" });
  }

  const triples = (body.match(/\b\w+, \w+,? and \w+\b/g) || []).length;
  if (triples >= 4) {
    findings.push({ kind: "rule-of-three", note: `${triples} three-item lists`, match: "vary the rhythm — two items, or four" });
  }

  return findings;
}

/** Pull only the parts of a kit that get sent to an employer. */
export function sendableText(markdown) {
  const section = (name) => (String(markdown).split(`## ${name}`)[1] || "").split(/\n---/)[0];
  return [section("Cover letter"), section("Application form answers")].join("\n\n").trim();
}
