import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSlop, sendableText } from "../src/slop.js";

const kinds = (t) => checkSlop(t).map((f) => f.kind);

test("catches the not-only-but-also construction", () => {
  assert.ok(kinds("He not only shipped the payments layer but also ran the deploys.").includes("not-only-but-also"));
});

test("catches AI vocabulary", () => {
  const k = kinds("I built robust systems and leverage modern tooling.");
  assert.equal(k.filter((x) => x === "vocab").length, 2);
});

test("catches a participle bolted on to manufacture significance", () => {
  assert.ok(kinds("I fixed the retry bug, demonstrating my attention to detail.").includes("tacked-participle"));
});

test("catches verb-dodging", () => {
  assert.ok(kinds("This project serves as evidence of his ability.").includes("verb-dodge"));
});

test("a factual contrast mid-sentence is not flagged", () => {
  // The bottleneck really was latency. Comparison is not a flourish.
  assert.deepEqual(kinds("The bottleneck was network latency rather than query time."), []);
});

test("plain declarative writing passes clean", () => {
  const text = "I built the payments layer on Myshoplet. A retried webhook paid an ambassador twice. I made the write conditional so it can only apply once.";
  assert.deepEqual(checkSlop(text), []);
});

test("one em dash is fine, several are flagged", () => {
  assert.deepEqual(kinds("I shipped it — on time."), []);
  assert.ok(kinds("I shipped it — on time — and it worked — mostly.").includes("em-dashes"));
});

test("sendableText extracts only what an employer receives", () => {
  const md = `# Role\n\n## Requirements audit\n\nsecret robust internal note\n\n---\n\n## Cover letter\n\nI built the thing.\n\n---\n\n## Application form answers\n\n**Q**\n\nA plain answer.\n\n---\n\n## Gaps\n\nrobust gap note`;
  const out = sendableText(md);
  assert.match(out, /I built the thing/);
  assert.match(out, /A plain answer/);
  assert.doesNotMatch(out, /secret|gap note/, "audit and gaps are for him, not the employer");
});

test("the checker reports findings rather than a pass/fail verdict", () => {
  const f = checkSlop("I leverage robust paradigms.");
  assert.ok(f.length >= 2);
  assert.ok(f.every((x) => typeof x.note === "string" && typeof x.match === "string"));
});
