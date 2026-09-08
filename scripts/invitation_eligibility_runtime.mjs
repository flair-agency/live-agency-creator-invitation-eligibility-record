import { isDeepStrictEqual } from "node:util";
import { validateInvitationEligibilityObservations } from "../src/contracts.mjs";
import { normalizeAccountKey, validateTargetManifest } from "./invitation_state_core.mjs";
import { applyRefresh, prepareRefresh, sha256Json, writePrivateJson } from "./invitation_lark_runtime.mjs";

const VERSION = 3;
const MODE = "invitation-eligibility-refresh";
function check(ok, message) { if (!ok) throw new TypeError(`Eligibility refresh: ${message}`); }
function destination(config) {
  return { appToken: config.appToken, creatorTableId: config.creatorTableId, invitationStateTableId: config.invitationStateTableId,
    dueViewId: config.dueViewId, fieldIds: structuredClone(config.fieldIds) };
}
function admission(observations, manifest) {
  validateInvitationEligibilityObservations(observations);
  validateTargetManifest(manifest);
  const targets = new Set(manifest.rows.map(row => normalizeAccountKey(row.accountKey)));
  check(observations.rowCount === targets.size && observations.creators.every(row => targets.has(normalizeAccountKey(row.accountKey))),
    "observations must cover the exact target manifest");
  const issues = observations.creators.filter(row => row.result !== "observed")
    .map(row => ({ accountKey: normalizeAccountKey(row.accountKey), result: row.result, reason: "no reviewed destination representation" }));
  return { issues, normalized: issues.length ? null : { observedAt: observations.observedAt, rowCount: observations.rowCount,
    creators: observations.creators.map(({ result, eligibility, ...row }) => ({ ...row, state: eligibility })) } };
}

// Meaning is reviewed outside the pure algorithm. A selected trusted caller
// must authorize the actual history snapshot each time, including readback.
function reviewedHistoryClient(client, config, reviewHistory) {
  check(typeof reviewHistory === "function", "explicit historical-meaning review callback is required");
  return { ...client, async listRecords(base, table, query) {
    const records = await client.listRecords(base, table, query);
    if (base === config.appToken && table === config.invitationStateTableId) {
      check(await reviewHistory({ destination: destination(config), records: structuredClone(records), recordsSha256: sha256Json(records) }) === true,
        "historical meanings have not been reviewed as eligibility; no conversion is allowed");
    }
    return records;
  } };
}

export async function prepareEligibilityRefresh({ client, config, manifest, observations, reviewHistory }) {
  const { issues, normalized } = admission(observations, manifest);
  if (issues.length) return { blocked: true, eligibilityIssues: issues, observations: structuredClone(observations),
    counts: { create: 0, update: 0, attach: 0, alreadyApplied: 0 }, operations: null, bindings: null };
  const prepared = await prepareRefresh({ client: reviewedHistoryClient(client, config, reviewHistory), config, manifest, observations: normalized });
  return { ...prepared, eligibilityIssues: [], observations: structuredClone(observations) };
}

export function eligibilityPlanSha256(plan) {
  return sha256Json({ version: plan.version, operationMode: plan.operationMode, generatedAt: plan.generatedAt,
    destination: plan.destination, manifest: plan.manifest, observations: plan.observations,
    operations: plan.operations, counts: plan.counts, bindings: plan.bindings, eligibilityIssues: plan.eligibilityIssues, blocked: plan.blocked });
}

export async function dryRunEligibility({ client, config, manifest, observations, reviewHistory, outputPlan }) {
  const prepared = await prepareEligibilityRefresh({ client, config, manifest, observations, reviewHistory });
  const plan = { version: VERSION, operationMode: MODE, generatedAt: new Date().toISOString(), destination: destination(config),
    manifest, observations: prepared.observations, operations: prepared.operations, counts: prepared.counts,
    bindings: prepared.bindings, eligibilityIssues: prepared.eligibilityIssues, blocked: prepared.blocked };
  plan.planSha256 = eligibilityPlanSha256(plan);
  await writePrivateJson(outputPlan, plan);
  return plan;
}

export async function applyEligibilityReviewed({ client, config, reviewed, args, reviewHistory }) {
  check(reviewed?.version === VERSION && reviewed.operationMode === MODE, "eligibility plan version and operation required");
  check(reviewed.planSha256 === eligibilityPlanSha256(reviewed) && reviewed.planSha256 === args.expectSha256, "reviewed plan hash differs");
  check(isDeepStrictEqual(reviewed.destination, destination(config)), "reviewed destination differs");
  check(reviewed.blocked === false && reviewed.eligibilityIssues.length === 0, "blocked observations cannot be applied");
  const prepared = await prepareEligibilityRefresh({ client, config, manifest: reviewed.manifest, observations: reviewed.observations, reviewHistory });
  check(!prepared.blocked && isDeepStrictEqual(prepared.bindings, reviewed.bindings), "current field bindings differ or plan is blocked");
  const { normalized } = admission(reviewed.observations, reviewed.manifest);
  return applyRefresh({ client: reviewedHistoryClient(client, config, reviewHistory), config,
    manifest: reviewed.manifest, observations: normalized, reviewedOperations: reviewed.operations, reviewedCounts: reviewed.counts,
    confirmCreate: args.confirmCreate, confirmUpdate: args.confirmUpdate, confirmAttach: args.confirmAttach,
    confirmAlreadyApplied: args.confirmAlreadyApplied });
}
