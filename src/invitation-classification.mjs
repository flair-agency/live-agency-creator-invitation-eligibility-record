import { createHash } from 'node:crypto';
import { validateInvitationEligibilityObservationsV2, validateInvitationEligibilityObservationsV3 } from './contracts.mjs';
import { normalizeAccountKey, validateTargetManifest, buildRefreshPlan, buildRefreshPlanFromHistory } from '../scripts/invitation_state_core.mjs';

const check = (ok, message) => { if (!ok) throw new TypeError(message); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Explicit destination taxonomy and reviewed evidence are inputs, never source rules.
export function classifyInvitationEligibilityObservations({ observations, manifest, statuses, refinements = [] }) {
  validateInvitationEligibilityObservationsV2(observations);
  validateTargetManifest(manifest);
  check(Array.isArray(statuses) && statuses.length > 0, 'explicit status taxonomy is required');
  const ids = new Map(), labels = new Set(), categories = new Map();
  for (const status of statuses) {
    check(status && Object.keys(status).every(key => ['id', 'label', 'parentId', 'invitationCategory'].includes(key)) &&
      text(status.id) && text(status.label) && (status.parentId === null || text(status.parentId)) &&
      (!Object.hasOwn(status, 'invitationCategory') || text(status.invitationCategory)), 'invalid status node');
    check(!ids.has(status.id) && !labels.has(status.label), 'duplicate status ID or label');
    ids.set(status.id, status); labels.add(status.label);
  }
  for (const status of statuses) {
    if (status.parentId === null) {
      check(!Object.hasOwn(status, 'invitationCategory'), 'root cannot have invitationCategory');
      continue;
    }
    check(ids.has(status.parentId) && ids.get(status.parentId).parentId === null, 'child requires a direct root parent');
    if (status.invitationCategory !== undefined) {
      const key = JSON.stringify([status.parentId, status.invitationCategory]);
      check(!categories.has(key), 'ambiguous parent/category mapping');
      categories.set(key, status);
    }
  }
  const targets = new Set(manifest.rows.map(row => normalizeAccountKey(row.accountKey)));
  check(targets.size === observations.rowCount && observations.creators.every(row => targets.has(normalizeAccountKey(row.accountKey))),
    'observations must cover the exact target manifest');
  check(Array.isArray(refinements), 'refinements must be an array');
  const evidence = new Map();
  for (const row of refinements) {
    check(row && Object.keys(row).every(key => ['accountKey', 'statusId', 'evidenceRef'].includes(key)) &&
      text(row.accountKey) && text(row.statusId) && text(row.evidenceRef), 'invalid refinement evidence');
    const account = normalizeAccountKey(row.accountKey);
    check(targets.has(account) && !evidence.has(account), 'duplicate or out-of-scope refinement');
    evidence.set(account, row);
  }
  const classifications = [], issues = [], creators = [];
  for (const row of observations.creators) {
    const accountKey = normalizeAccountKey(row.accountKey);
    const refinement = evidence.get(accountKey);
    if (row.result !== 'observed') {
      check(!refinement, 'unobserved outcomes cannot be refined');
      issues.push({ accountKey, result: row.result, reason: 'no reviewed destination representation' });
      continue;
    }
    const parent = statuses.find(node => node.parentId === null && node.label === row.eligibility);
    check(parent, 'observed parent has no exact root representation');
    const categoryChild = row.invitationCategory === null ? null : categories.get(JSON.stringify([parent.id, row.invitationCategory]));
    check(row.invitationCategory === null || categoryChild, 'observed category has no exact child representation');
    const refined = refinement ? ids.get(refinement.statusId) : null;
    check(!refinement || (refined && refined.parentId === parent.id), 'refinement must target a child of the observed root');
    check(!refined || !categoryChild || refined.id === categoryChild.id, 'refinement conflicts with observed category');
    const chosen = refined ?? categoryChild ?? parent;
    classifications.push({ accountKey, parentStatusId: parent.id, statusId: chosen.id,
      invitationCategory: row.invitationCategory, evidenceRef: refinement?.evidenceRef ?? null });
    const { result, eligibility, invitationCategory, ...identity } = row;
    creators.push({ ...structuredClone(identity), state: chosen.label });
  }
  const receipt = { version: 1, inputSha256: hash({ observations, manifest, statuses, refinements }),
    classifications, issues, blocked: issues.length > 0 };
  return { ...receipt, receiptSha256: hash(receipt), observations: receipt.blocked ? null :
    { observedAt: observations.observedAt, rowCount: creators.length, creators } };
}

// An explicit compliance rule is required before a Provider signal can select
// a child status. Unknown raw reasons deliberately have no such effect.
export function classifyInvitationEligibilityObservationsV3({ observations, manifest, statuses, refinements = [], complianceRules = [] }) {
  validateInvitationEligibilityObservationsV3(observations);
  check(Array.isArray(complianceRules), 'compliance rules must be an array');
  const bySignal = new Map();
  for (const rule of complianceRules) {
    check(rule && Object.keys(rule).every(key => ['signal', 'statusId', 'evidenceRef'].includes(key)) &&
      ['multiple_account_risk', 'other_agency_membership'].includes(rule.signal) && text(rule.statusId) && text(rule.evidenceRef) && !bySignal.has(rule.signal), 'invalid compliance rule');
    bySignal.set(rule.signal, rule);
  }
  const derived = observations.creators.flatMap(row => (row.complianceSignals ?? []).map(signal => ({ accountKey: row.accountKey, signal, rule: bySignal.get(signal) ?? null })));
  const unresolved = derived.filter(item => !item.rule);
  const derivedRefinements = new Map();
  for (const item of derived.filter(item => item.rule)) {
    const accountKey = normalizeAccountKey(item.accountKey);
    const previous = derivedRefinements.get(accountKey);
    check(!previous || previous.statusId === item.rule.statusId, 'conflicting compliance target statuses');
    derivedRefinements.set(accountKey, { accountKey, statusId: item.rule.statusId,
      evidenceRefs: [...(previous?.evidenceRefs ?? []), item.rule.evidenceRef] });
  }
  const v2 = { ...observations, contractVersion: 'invitation-eligibility-observations/v2', creators: observations.creators.map(({ status, reason, complianceSignals, ...row }) => ({ ...row, eligibility: status })) };
  const result = classifyInvitationEligibilityObservations({ observations: v2, manifest, statuses,
    refinements: [...refinements, ...[...derivedRefinements.values()].map(({ accountKey, statusId, evidenceRefs }) => ({
      accountKey, statusId, evidenceRef: evidenceRefs.length === 1 ? evidenceRefs[0] : JSON.stringify([...new Set(evidenceRefs)].sort()),
    }))] });
  const receipt = { ...result, inputSha256: hash({ observations, manifest, statuses, refinements, complianceRules }),
    observedReasons: observations.creators.map(row => ({accountKey: normalizeAccountKey(row.accountKey), reason:row.reason, complianceSignals:row.complianceSignals ?? []})),
    complianceIssues: unresolved.map(item => ({accountKey:normalizeAccountKey(item.accountKey), signal:item.signal, reason:'explicit compliance rule required'})) };
  receipt.blocked = result.blocked || receipt.complianceIssues.length > 0;
  if (receipt.blocked) receipt.observations = null;
  const hashPayload = { ...receipt };
  delete hashPayload.receiptSha256;
  receipt.receiptSha256 = hash(hashPayload);
  return receipt;
}

export async function buildClassifiedInvitationRefreshPlan({ observations, manifest, statuses, refinements = [], ...inputs }) {
  const classification = classifyInvitationEligibilityObservations({ observations, manifest, statuses, refinements });
  const plan = classification.blocked ? null : await buildRefreshPlan({ ...inputs, manifest, observations: classification.observations });
  return { classification, plan };
}

export function buildClassifiedInvitationRefreshPlanFromHistory({ observations, manifest, statuses, refinements = [], storedHistory, invalidStored = [] }) {
  const classification = classifyInvitationEligibilityObservations({ observations, manifest, statuses, refinements });
  const plan = classification.blocked ? null : buildRefreshPlanFromHistory({
    manifest, observations: classification.observations, storedHistory, invalidStored,
  });
  return { classification, plan };
}
