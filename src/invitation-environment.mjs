import { createHash, randomUUID } from 'node:crypto';
import { open, constants } from 'node:fs/promises';
import path from 'node:path';
import { validateProviderResult } from '@flair-agency/provider-protocol';
import { validateInvitationEligibilityObservationsV2 } from './contracts.mjs';
import { classifyInvitationEligibilityObservations } from './invitation-classification.mjs';
import { normalizeAccountKey, validateTargetManifest, hasBlockingRefreshIssues, buildRefreshPlanFromHistory } from '../scripts/invitation_state_core.mjs';

export const DATASET_READ = 'record-dataset-read/v1';
// TODO: selected source handoff (#6) and reviewed write/readback (#14) remain separate connections.
// https://github.com/flair-agency/live-agency/issues/14
const text = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const rowsHash = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function requireValue(ok, code, stage) {
  if (!ok) throw Object.assign(new TypeError(code), { code, stage });
}
function keys(value, expected, stage) {
  requireValue(object(value) && same(Object.keys(value).sort(), [...expected].sort()), 'INVITATION_CONFIGURATION_INVALID', stage);
}

// These are business roles mapped to logical dataset keys, never service columns.
export function validateInvitationEnvironmentConfiguration(value, selection) {
  const c = structuredClone(value), stage = 'configuration';
  keys(c, ['schemaVersion', 'environment', 'creators', 'statuses', 'history', 'categories'], stage);
  requireValue(c.schemaVersion === 1, 'INVITATION_CONFIGURATION_INVALID', stage);
  keys(c.environment, ['environmentId', 'environmentKind', 'platformId'], stage);
  requireValue(Object.keys(c.environment).every(key => text(c.environment[key]) && c.environment[key] === selection?.[key]),
    'INVITATION_SELECTION_MISMATCH', stage);
  const mappings = {creators:['account'], statuses:['label','parent'],
    history:['creatorRecordId','state','externalUserId','nickname','observedAtMs','avatarHashes']};
  for (const [role, fields] of Object.entries(mappings)) {
    keys(c[role], ['dataset', role === 'creators' ? 'queries' : 'query', 'fields'], stage);
    requireValue(text(c[role].dataset), 'INVITATION_CONFIGURATION_INVALID', stage);
    keys(c[role].fields, fields, stage);
    const values = Object.values(c[role].fields);
    requireValue(values.every(text) && new Set(values).size === values.length, 'INVITATION_CONFIGURATION_INVALID', stage);
    if (role === 'creators') {
      keys(c.creators.queries, ['all','due'], stage);
      requireValue(Object.values(c.creators.queries).every(text), 'INVITATION_CONFIGURATION_INVALID', stage);
    } else requireValue(text(c[role].query), 'INVITATION_CONFIGURATION_INVALID', stage);
  }
  requireValue(Array.isArray(c.categories), 'INVITATION_CONFIGURATION_INVALID', stage);
  const ids = new Set();
  for (const entry of c.categories) {
    keys(entry, ['statusId','invitationCategory'], stage);
    requireValue(text(entry.statusId) && text(entry.invitationCategory) && !ids.has(entry.statusId),
      'INVITATION_CONFIGURATION_INVALID', stage);
    ids.add(entry.statusId);
  }
  return c;
}

function readSession(access, configuration, saved = null) {
  requireValue(typeof access?.invoke === 'function' && object(access.selection) &&
    /^[0-9a-f]{64}$/.test(access.selection.generation ?? ''), 'INVITATION_SELECTION_INVALID', 'selection');
  const selection = structuredClone(access.selection);
  const config = validateInvitationEnvironmentConfiguration(configuration, selection);
  const configurationFingerprint = hash(config);
  let readIdentity = saved?.readIdentity ?? null;
  if (saved) requireValue(saved.version === 1 && same(saved.selection, selection) &&
    saved.configurationFingerprint === configurationFingerprint && object(readIdentity),
  'INVITATION_TARGET_RECEIPT_CHANGED', 'selection');
  const reads = [];
  return {config, selection, configurationFingerprint, reads,
    get readIdentity() { return structuredClone(readIdentity); },
    async read(role, query, parameters = {}) {
      requireValue(same(selection, access.selection), 'INVITATION_SELECTION_MISMATCH', 'read');
      const request = {requestId:randomUUID(), capability:DATASET_READ, version:'1.0.0', context:selection,
        input:{dataset:role.dataset, query, parameters}};
      const reply = await access.invoke(request);
      requireValue(same(selection, access.selection) && same(reply?.selection, selection), 'INVITATION_SELECTION_MISMATCH', 'read');
      try { validateProviderResult(reply.result, request); }
      catch (cause) { throw Object.assign(new TypeError('INVITATION_READ_PROTOCOL_INVALID', {cause}), {code:'INVITATION_READ_PROTOCOL_INVALID',stage:'read'}); }
      if (reply.result.status === 'failed') {
        throw Object.assign(new Error('INVITATION_DATASET_READ_FAILED'), {code:'INVITATION_DATASET_READ_FAILED',
          stage:'read', requestId:request.requestId, providerCode:reply.result.error.code,
          providerError:structuredClone(reply.result.error)});
      }
      const out = reply.result.output;
      requireValue(reply.result.status === 'done' && out?.complete === true && out.dataset === role.dataset &&
        out.query === query && same(out.scope, parameters) && same(out.selection, selection) &&
        /^[0-9a-f]{64}$/.test(out.configurationFingerprint ?? '') && Array.isArray(out.rows),
      'INVITATION_READ_INCOMPLETE', 'read');
      const binding = reply.binding;
      requireValue(object(binding) && ['packageName','packageVersion','bindingId','knowledgeVersion'].every(key => text(binding[key])),
        'INVITATION_READ_BINDING_INVALID', 'read');
      const identity = {binding, configurationFingerprint:out.configurationFingerprint};
      requireValue(!readIdentity || same(readIdentity, identity), 'INVITATION_READ_CONFIGURATION_CHANGED', 'read');
      readIdentity ??= structuredClone(identity);
      const seen = new Set();
      for (const row of out.rows) {
        requireValue(text(row?.recordId) && !seen.has(row.recordId) && object(row.values), 'INVITATION_READ_ROWS_INVALID', 'read');
        seen.add(row.recordId);
        requireValue(Object.values(role.fields).every(key => Object.hasOwn(row.values, key)), 'INVITATION_READ_COLUMNS_MISSING', 'read');
      }
      reads.push({requestId:request.requestId, dataset:out.dataset, query, scope:structuredClone(out.scope), rowCount:out.rows.length});
      return structuredClone(out.rows);
    }};
}

function creatorTargets(rows, accountField) {
  const seen = new Set();
  return rows.map(row => {
    requireValue(text(row.values[accountField]), 'INVITATION_CREATOR_INVALID', 'targets');
    const accountKey = normalizeAccountKey(row.values[accountField]);
    requireValue(text(accountKey) && !seen.has(accountKey), 'INVITATION_CREATOR_AMBIGUOUS', 'targets');
    seen.add(accountKey);
    return {creatorRecordId:row.recordId, accountKey};
  });
}

export async function prepareEnvironmentInvitationTargets({access, configuration, mode = 'due', selectedAccounts = [], limit = null,
  now = () => new Date().toISOString()}) {
  requireValue(['due','selected','all'].includes(mode) && Array.isArray(selectedAccounts) &&
    (mode === 'selected' || selectedAccounts.length === 0) &&
    (limit === null || (Number.isSafeInteger(limit) && limit > 0)), 'INVITATION_TARGET_SELECTION_INVALID', 'targets');
  const s = readSession(access, configuration), c = s.config.creators;
  let rows = creatorTargets(await s.read(c, c.queries[mode === 'due' ? 'due' : 'all']), c.fields.account);
  if (mode === 'selected') {
    const byAccount = new Map(rows.map(row => [row.accountKey,row])), seen = new Set();
    rows = selectedAccounts.map(account => {
      requireValue(text(account), 'INVITATION_TARGET_SELECTION_INVALID', 'targets');
      const key = normalizeAccountKey(account);
      requireValue(!seen.has(key) && byAccount.has(key), 'INVITATION_TARGET_SELECTION_INVALID', 'targets');
      seen.add(key); return byAccount.get(key);
    });
  }
  if (limit !== null) rows = rows.slice(0, limit);
  const manifest = {version:1, generatedAt:now(), targetMode:mode, rowCount:rows.length, rows, rowsSha256:rowsHash(rows)};
  validateTargetManifest(manifest);
  const receipt = {version:1, selection:s.selection, configurationFingerprint:s.configurationFingerprint,
    readIdentity:s.readIdentity, manifest, reads:s.reads};
  return {...receipt, receiptSha256:hash(receipt)};
}

async function verifyAvatars(observations) {
  for (const row of observations.creators) {
    if (!row.avatar) continue;
    const avatar = row.avatar;
    requireValue(path.isAbsolute(avatar.path), 'INVITATION_AVATAR_INVALID', 'observations');
    const file = await open(avatar.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      requireValue(stat.isFile() && stat.size === avatar.size, 'INVITATION_AVATAR_INVALID', 'observations');
      const digest = createHash('sha256');
      let bytes = 0;
      for await (const chunk of file.createReadStream({autoClose:false})) {
        bytes += chunk.length;
        requireValue(bytes <= avatar.size, 'INVITATION_AVATAR_INVALID', 'observations');
        digest.update(chunk);
      }
      requireValue(bytes === avatar.size && digest.digest('hex') === avatar.sha256, 'INVITATION_AVATAR_INVALID', 'observations');
    } finally { await file.close(); }
  }
}

export async function prepareEnvironmentInvitationPlan({access, configuration, targets, observations, refinements = []}) {
  const {receiptSha256, ...receipt} = structuredClone(targets);
  requireValue(receiptSha256 === hash(receipt), 'INVITATION_TARGET_RECEIPT_CHANGED', 'targets');
  const s = readSession(access, configuration, receipt), c = s.config;
  const manifest = validateTargetManifest(receipt.manifest);
  requireValue(manifest.rowsSha256 === rowsHash(manifest.rows), 'INVITATION_TARGET_RECEIPT_CHANGED', 'targets');
  observations = structuredClone(observations); refinements = structuredClone(refinements);
  try { validateInvitationEligibilityObservationsV2(observations); }
  catch (cause) { throw Object.assign(new TypeError('INVITATION_OBSERVATIONS_INVALID', {cause}), {
    code:'INVITATION_OBSERVATIONS_INVALID', stage:'observations', reason:cause.message}); }
  const live = await s.read(c.creators, c.creators.queries.all);
  const byId = new Map(live.map(row => [row.recordId,row]));
  for (const row of manifest.rows) {
    const value = byId.get(row.creatorRecordId)?.values[c.creators.fields.account];
    requireValue(text(value) && normalizeAccountKey(value) === normalizeAccountKey(row.accountKey),
      'INVITATION_TARGET_CHANGED', 'targets');
  }
  const due = manifest.targetMode === 'due' ? new Set((await s.read(c.creators, c.creators.queries.due)).map(row => row.recordId)) : null;
  const master = await s.read(c.statuses, c.statuses.query);
  const categories = new Map(c.categories.map(row => [row.statusId,row.invitationCategory]));
  requireValue(c.categories.every(row => master.some(node => node.recordId === row.statusId)), 'INVITATION_CATEGORY_MAPPING_INVALID', 'classification');
  const statuses = master.map(row => ({id:row.recordId, label:row.values[c.statuses.fields.label],
    parentId:row.values[c.statuses.fields.parent], ...(categories.has(row.recordId) ? {invitationCategory:categories.get(row.recordId)} : {})}));
  let classification;
  try { classification = classifyInvitationEligibilityObservations({observations, manifest, statuses, refinements}); }
  catch (cause) { throw Object.assign(new TypeError('INVITATION_CLASSIFICATION_INVALID', {cause}), {
    code:'INVITATION_CLASSIFICATION_INVALID', stage:'classification', reason:cause.message}); }
  if (!classification.blocked) {
    try { await verifyAvatars(observations); }
    catch (cause) {
      if (cause.stage === 'observations') throw cause;
      throw Object.assign(new Error('INVITATION_AVATAR_READ_FAILED', {cause}), {
        code:'INVITATION_AVATAR_READ_FAILED', stage:'observations', filesystemCode:cause.code});
    }
  }
  const recordIds = manifest.rows.map(row => row.creatorRecordId), allowed = new Set(recordIds);
  // Preserve the adopted early stop: unresolved classifications do not initiate history or attachment reads.
  const history = !classification.blocked && recordIds.length ? await s.read(c.history, c.history.query, {recordIds}) : [];
  const invalidStored = [];
  const storedHistory = history.flatMap(row => {
    const fields = Object.fromEntries(Object.entries(c.history.fields).map(([role,key]) => [role,row.values[key]]));
    requireValue(typeof fields.creatorRecordId === 'string' && allowed.has(fields.creatorRecordId), 'INVITATION_HISTORY_SCOPE_INVALID', 'history');
    // Optional absence is declared by the Provider; invalid present values remain invalidStored.
    if (fields.externalUserId === null) fields.externalUserId = '';
    if (fields.nickname === null) fields.nickname = '';
    if (typeof fields.externalUserId === 'string') fields.externalUserId = fields.externalUserId.trim();
    if (typeof fields.nickname === 'string') fields.nickname = fields.nickname.normalize('NFKC').trim();
    if (Array.isArray(fields.avatarHashes) && fields.avatarHashes.some(value => !/^[0-9a-f]{64}$/.test(value ?? ''))) {
      invalidStored.push({recordId:row.recordId, reason:'normalized attachment content hash is invalid'});
      return [];
    }
    return [{recordId:row.recordId, ...fields}];
  });
  const plan = classification.blocked ? null : buildRefreshPlanFromHistory({
    observations:classification.observations, manifest, storedHistory, invalidStored});
  if (plan && due) {
    for (const row of [...plan.creates,...plan.updates,...plan.attachExisting]) {
      if (!due.has(row.creatorRecordId)) plan.staleObservations.push({accountKey:row.accountKey, reason:'creator is no longer due'});
    }
  }
  const blocked = classification.blocked || hasBlockingRefreshIssues(plan);
  const result = {version:1, status:blocked ? 'blocked' : 'prepared', selection:s.selection,
    configurationFingerprint:s.configurationFingerprint, readIdentity:s.readIdentity,
    targetReceiptSha256:receiptSha256, observations, classification, plan, reads:s.reads,
    businessWorkflowVerified:false};
  return {...result, planSha256:hash(result)};
}
