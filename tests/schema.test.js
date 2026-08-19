import { test } from "node:test";
import assert from "node:assert/strict";
import { SCORE_FIELDS, APPLY_FIELDS, toGoogle, toJSONSchema, validateScore, validateApply } from "../src/providers/schema.js";
import { createProvider } from "../src/providers/index.js";

test("the Google dialect uses uppercase types and omits additionalProperties", () => {
  const s = toGoogle(SCORE_FIELDS);
  assert.equal(s.type, "OBJECT");
  assert.equal(s.properties.score.type, "INTEGER");
  assert.equal(s.properties.reason.type, "STRING");
  assert.equal(s.additionalProperties, undefined);
  assert.deepEqual(s.required, Object.keys(SCORE_FIELDS));
});

test("the Google dialect expands array-of-object fields", () => {
  const s = toGoogle(APPLY_FIELDS);
  const b = s.properties.cv_bullets;
  assert.equal(b.type, "ARRAY");
  assert.equal(b.items.type, "OBJECT");
  assert.equal(b.items.properties.bullet.type, "STRING");
  assert.deepEqual(b.items.required, ["bullet", "rationale"]);
});

test("JSON Schema is strict — additionalProperties is false at every level", () => {
  const s = toJSONSchema(APPLY_FIELDS);
  assert.equal(s.additionalProperties, false);
  assert.equal(s.properties.answers.items.additionalProperties, false);
  assert.equal(s.properties.answers.type, "array");
  assert.equal(s.properties.cover_letter.type, "string");
});

test("every field carries a description in both dialects", () => {
  for (const fields of [SCORE_FIELDS, APPLY_FIELDS]) {
    for (const [k, v] of Object.entries(toGoogle(fields).properties)) {
      assert.ok(v.description?.length > 10, `google: ${k} needs a real description`);
    }
    for (const [k, v] of Object.entries(toJSONSchema(fields).properties)) {
      assert.ok(v.description?.length > 10, `jsonschema: ${k} needs a real description`);
    }
  }
});

test("validateScore rejects a score outside 0-100", () => {
  const base = Object.fromEntries(Object.keys(SCORE_FIELDS).map((k) => [k, ["score", "odds"].includes(k) ? 50 : "x"]));
  assert.doesNotThrow(() => validateScore(base));
  assert.throws(() => validateScore({ ...base, score: 140 }), /out of range/);
  assert.throws(() => validateScore({ ...base, score: -1 }), /out of range/);
  assert.throws(() => validateScore({ ...base, score: "high" }), /out of range/);
});

test("odds is validated as strictly as score — an unscored chance is not a chance", () => {
  const base = Object.fromEntries(Object.keys(SCORE_FIELDS).map((k) => [k, ["score", "odds"].includes(k) ? 50 : "x"]));
  assert.doesNotThrow(() => validateScore(base));
  assert.throws(() => validateScore({ ...base, odds: 120 }), /odds out of range/);
  assert.throws(() => validateScore({ ...base, odds: "likely" }), /odds out of range/);
});

test("fit and odds are independent — a role can be wanted and unwinnable", () => {
  const base = Object.fromEntries(Object.keys(SCORE_FIELDS).map((k) => [k, ["score", "odds"].includes(k) ? 50 : "x"]));
  const v = validateScore({ ...base, score: 90, odds: 5 });
  assert.equal(v.score, 90);
  assert.equal(v.odds, 5);
});

test("validateScore rejects a missing field rather than passing a half-built verdict", () => {
  assert.throws(() => validateScore({ score: 70 }), /missing field/);
  assert.throws(() => validateScore(null), /not an object/);
});

test("validateApply rejects a stub cover letter or an empty section", () => {
  const ok = {
    cover_letter: "x".repeat(250),
    requirements: [{ requirement: "r", kind: "required", verdict: "met", evidence: "e" }],
    cv_bullets: [{ bullet: "a", rationale: "b" }],
    answers: [{ question: "q", answer: "a" }],
    gaps: [{ gap: "g" }],
    questions_to_ask: [{ question: "q" }],
  };
  assert.doesNotThrow(() => validateApply(ok));
  assert.throws(() => validateApply({ ...ok, cover_letter: "too short" }), /cover letter/);
  assert.throws(() => validateApply({ ...ok, gaps: [] }), /gaps/);
  assert.throws(() => validateApply({ ...ok, requirements: [] }), /requirements/);
});

test("provider resolution prefers a free provider over a paid one", () => {
  const p = createProvider({ GEMINI_API_KEY: "k", ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k" });
  assert.equal(p.name, "gemini");
  assert.equal(p.free, true);
});

test("a paid provider is only chosen when it is the only key present", () => {
  const p = createProvider({ ANTHROPIC_API_KEY: "k" });
  assert.equal(p.name, "anthropic");
  assert.equal(p.free, false);
});

test("no keys resolves to no provider rather than throwing", () => {
  assert.equal(createProvider({}), null);
});

test("naming a provider without its key fails loudly", () => {
  assert.throws(() => createProvider({ SHORTLIST_PROVIDER: "groq" }), /its API key is not set/);
});

test("an explicit provider wins over a free default", () => {
  const p = createProvider({ SHORTLIST_PROVIDER: "anthropic", GEMINI_API_KEY: "k", ANTHROPIC_API_KEY: "k" });
  assert.equal(p.name, "anthropic");
});

test("every provider exposes the same interface", () => {
  const envs = [
    { GEMINI_API_KEY: "k" },
    { ANTHROPIC_API_KEY: "k" },
    { GROQ_API_KEY: "k" },
    { OPENROUTER_API_KEY: "k" },
    { SHORTLIST_PROVIDER: "ollama" },
  ];
  for (const env of envs) {
    const p = createProvider(env);
    assert.equal(typeof p.complete, "function", `${p.name} must expose complete()`);
    assert.equal(typeof p.model, "string");
    assert.equal(typeof p.free, "boolean");
    assert.ok(p.concurrency >= 1);
  }
});

test("the requirements summary is counted from the rows, not taken from the model", async () => {
  const { summariseRequirements } = await import("../src/apply.js");
  const rows = [
    { kind: "required", verdict: "met" }, { kind: "required", verdict: "met" },
    { kind: "required", verdict: "met" }, { kind: "required", verdict: "met" },
    { kind: "required", verdict: "partial" }, { kind: "required", verdict: "partial" },
    { kind: "preferred", verdict: "met" }, { kind: "preferred", verdict: "partial" },
  ];
  // The model reported "1 partial, 1 missing" for exactly this shape.
  assert.equal(summariseRequirements(rows), "Meets 4 of 6 required · 2 partial · 1 of 2 preferred");
});

test("a clean sweep reads as such, with no zero counts", async () => {
  const { summariseRequirements } = await import("../src/apply.js");
  assert.equal(summariseRequirements([{ kind: "required", verdict: "met" }]), "Meets 1 of 1 required");
});

test("missing requirements are counted separately from partial ones", async () => {
  const { summariseRequirements } = await import("../src/apply.js");
  const rows = [{ kind: "required", verdict: "met" }, { kind: "required", verdict: "missing" }];
  assert.equal(summariseRequirements(rows), "Meets 1 of 2 required · 1 missing");
});

test("a kit claiming a technology the user has never used is rejected, not edited", async () => {
  // The failure this guards: a posting named two technologies prominently, and the model
  // wrote them into the cover letter four times each — matching the JOB's stack onto the
  // applicant rather than reporting the applicant's. A claim like that survives the screen
  // and collapses at the first interview question, with no way to know it was there.
  // The prompt already said "never invent a technology" and was ignored, so the fix is a
  // gate (profile.neverClaim) rather than more instruction.
  const { findFalseClaims } = await import("../src/apply.js");
  const profile = { neverClaim: { terms: [
    { term: "postgres", truth: "MongoDB, not Postgres." },
    { term: "typescript", truth: "Zero .ts files." },
  ] } };

  const bad = { cover_letter: "I ran Myshoplet on Node and Postgres.", answers: [], cv_bullets: [] };
  assert.deepEqual(findFalseClaims(bad, profile).map((c) => c.term), ["postgres"]);

  const worse = {
    cover_letter: "Full-stack TypeScript work.",
    answers: [{ question: "q", answer: "Heavy Postgres tuning." }],
    cv_bullets: [],
  };
  assert.equal(findFalseClaims(worse, profile).length, 2);
});

test("the gate reads what gets sent, not the audit he keeps for himself", async () => {
  const { findFalseClaims } = await import("../src/apply.js");
  const profile = { neverClaim: { terms: [{ term: "postgres", truth: "MongoDB." }] } };
  // Naming Postgres in a requirements row is correct — that is the gap being recorded.
  const kit = {
    cover_letter: "I build payment systems.",
    answers: [], cv_bullets: [],
    requirements: [{ requirement: "Postgres at scale", verdict: "missing", evidence: "no Postgres" }],
    gaps: [{ gap: "No production Postgres" }],
  };
  assert.deepEqual(findFalseClaims(kit, profile), []);
});

test("a substring is not a claim", async () => {
  const { findFalseClaims } = await import("../src/apply.js");
  const profile = { neverClaim: { terms: [{ term: "rust", truth: "no Rust" }] } };
  const kit = { cover_letter: "I am not frustrated by trusted systems.", answers: [], cv_bullets: [] };
  assert.deepEqual(findFalseClaims(kit, profile), []);
});
