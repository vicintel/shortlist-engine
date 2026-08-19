import { test } from "node:test";
import assert from "node:assert/strict";

// workplaceType must beat isRemote — Notion ships isRemote:true on Hybrid SF roles.
const remoteHint = (j) =>
  j.workplaceType === "Remote" ? true
  : j.workplaceType ? false
  : j.isRemote === true ? true
  : j.isRemote === false ? false
  : null;

test("workplaceType Hybrid overrides isRemote true", () => {
  assert.equal(remoteHint({ isRemote: true, workplaceType: "Hybrid" }), false);
});
test("workplaceType Remote is remote", () => {
  assert.equal(remoteHint({ isRemote: false, workplaceType: "Remote" }), true);
});
test("isRemote is still used when workplaceType is absent", () => {
  assert.equal(remoteHint({ isRemote: true }), true);
  assert.equal(remoteHint({}), null);
});
