import { test } from "node:test";
import assert from "node:assert/strict";
import { createMailer, explainMailError } from "../src/mail.js";
import { digestSubject } from "../src/digest.js";

const GMAIL = { GMAIL_USER: "me@gmail.com", GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop" };

test("no credentials resolves to no mailer rather than throwing", () => {
  assert.equal(createMailer({}), null);
});

test("gmail is chosen when configured", () => {
  const m = createMailer(GMAIL);
  assert.equal(m.name, "gmail");
});

test("the digest defaults to your own inbox", () => {
  assert.equal(createMailer(GMAIL).to, "me@gmail.com");
  assert.equal(createMailer({ ...GMAIL, DIGEST_TO: "other@x.com" }).to, "other@x.com");
});

test("gmail is preferred over resend when both are set", () => {
  assert.equal(createMailer({ ...GMAIL, RESEND_API_KEY: "re_x" }).name, "gmail");
});

test("MAIL_TRANSPORT overrides the default preference", () => {
  const m = createMailer({ ...GMAIL, RESEND_API_KEY: "re_x", DIGEST_TO: "me@gmail.com", MAIL_TRANSPORT: "resend" });
  assert.equal(m.name, "resend");
});

test("naming a transport without its credentials fails loudly", () => {
  assert.throws(() => createMailer({ MAIL_TRANSPORT: "gmail" }), /credentials are not set/);
  assert.throws(() => createMailer({ MAIL_TRANSPORT: "resend" }), /credentials are not set/);
});

test("an app password is accepted in the spaced form Google displays", () => {
  // Google shows 16 characters in four groups; pasting it verbatim must work.
  assert.doesNotThrow(() => createMailer(GMAIL));
  assert.equal(createMailer(GMAIL).name, "gmail");
});

test("a partly configured gmail account is treated as unconfigured", () => {
  assert.equal(createMailer({ GMAIL_USER: "me@gmail.com" }), null);
  assert.equal(createMailer({ GMAIL_APP_PASSWORD: "x" }), null);
});

test("a bad-login error explains that an app password is required", () => {
  const msg = explainMailError(new Error("Invalid login: 535-5.7.8 Username and Password not accepted"));
  assert.match(msg, /app password/i);
  assert.match(msg, /apppasswords/);
  assert.match(msg, /normal Google password will not work/);
});

test("a network error is not misreported as a credential problem", () => {
  const msg = explainMailError(new Error("connect ETIMEDOUT 142.250.1.108:465"));
  assert.match(msg, /smtp\.gmail\.com/);
  assert.doesNotMatch(msg, /app password/i);
});

test("an unrecognised error is passed through rather than swallowed", () => {
  assert.equal(explainMailError(new Error("something odd")), "something odd");
});

test("the subject line reflects the count and the top score", () => {
  assert.equal(digestSubject([{ score: 77 }, { score: 70 }]), "2 roles worth a look — top match 77");
  assert.equal(digestSubject([{ score: 81 }]), "1 role worth a look — top match 81");
  assert.equal(digestSubject([]), "No roles cleared the bar today");
});
