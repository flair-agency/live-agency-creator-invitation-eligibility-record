import assert from "node:assert/strict";
import test from "node:test";
import { validateInvitationEligibilityObservations, validateInvitationObservations, INVITATION_ELIGIBILITY_CONTRACT } from "../src/contracts.mjs";
import { prepareEligibilityRefresh } from "../scripts/invitation_eligibility_runtime.mjs";
const snapshot = () => ({ contractVersion: INVITATION_ELIGIBILITY_CONTRACT, observedAt: "2030-01-02T03:04:05Z", rowCount: 1,
  creators: [{ accountKey: "synthetic.creator", result: "observed", eligibility: "synthetic_eligible" }] });
const manifest = { version: 1, targetMode: "selected", rowCount: 1, rows: [{ creatorRecordId: "recSynthetic", accountKey: "synthetic.creator" }] };
test("new eligibility observations require an explicit contract and do not upgrade legacy state input", () => {
  const legacy = { observedAt: "2030-01-02T03:04:05Z", rowCount: 1, creators: [{ accountKey: "synthetic.creator", state: "synthetic_eligible" }] };
  assert.equal(validateInvitationObservations(legacy), legacy);
  assert.throws(() => validateInvitationEligibilityObservations(legacy), /explicit/);
  const valid = snapshot(); assert.equal(validateInvitationEligibilityObservations(valid), valid);
});
test("rejects mixed progress, unknown outcomes, invalid dates and normalized duplicate accounts", () => {
  for (const mutate of [
    value => { value.creators[0].invitationProgress = "sent"; },
    value => { value.creators[0].state = "pending"; },
    value => { value.creators[0].result = "pending"; },
    value => { value.creators[0].eligibility = ""; },
    value => { value.observedAt = "2030-02-30T03:04:05Z"; },
    value => { value.creators.push({ ...value.creators[0], accountKey: "＠ＳＹＮＴＨＥＴＩＣ.creator" }); value.rowCount = 2; },
  ]) { const value = snapshot(); mutate(value); assert.throws(() => validateInvitationEligibilityObservations(value)); }
});
for (const result of ["not_found", "unavailable"]) test(`${result} stays explicit and blocks before destination access`, async () => {
  const value = snapshot(); value.creators[0] = { accountKey: "synthetic.creator", result, eligibility: null };
  assert.equal(validateInvitationEligibilityObservations(value), value);
  let reads = 0;
  const prepared = await prepareEligibilityRefresh({ client: { listFields() { reads++; throw new Error("unexpected access"); } }, config: {}, manifest, observations: value });
  assert.equal(reads, 0); assert.equal(prepared.blocked, true);
  assert.equal(prepared.observations.creators[0].eligibility, null);
  assert.equal(prepared.eligibilityIssues[0].result, result);
  assert.deepEqual(prepared.counts, { create: 0, update: 0, attach: 0, alreadyApplied: 0 });
  value.creators[0].eligibility = "synthetic_ineligible";
  assert.throws(() => validateInvitationEligibilityObservations(value), /must remain null/);
});
test("unknown outcomes do not relax exact target coverage", async () => {
  const value = snapshot(); value.creators[0] = { accountKey: "unrequested", result: "unavailable", eligibility: null };
  await assert.rejects(prepareEligibilityRefresh({ client: {}, config: {}, manifest, observations: value }), /exact target/);
});
test("a typed declaration alone does not admit historical meanings", async () => {
  await assert.rejects(prepareEligibilityRefresh({ client: {}, config: {}, manifest, observations: snapshot() }), /historical-meaning review/);
});
