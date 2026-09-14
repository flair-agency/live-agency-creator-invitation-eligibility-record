import { createHash, randomUUID } from 'node:crypto';
import { open, constants } from 'node:fs/promises';
import path from 'node:path';
import { validateProviderResult } from '@flair-agency/provider-protocol';
import { validateInvitationEligibilityObservationsV2 } from './contracts.mjs';
import { classifyInvitationEligibilityObservations } from './invitation-classification.mjs';
import { normalizeAccountKey, validateTargetManifest, hasBlockingRefreshIssues, buildRefreshPlanFromHistory } from '../scripts/invitation_state_core.mjs';

export const DATASET_READ = 'record-dataset-read/v1';
export const DATASET_WRITE = 'record-dataset-write/v1';
export const INVITATION_SOURCE = 'creator-invitation-observation-source/v2';
export const INVITATION_SOURCE_INPUT_KIND = 'application/vnd.live-agency.creator-invitation-targets+json';
// TODO: https://github.com/flair-agency/live-agency/issues/6
// Runtime correlation binds this handoff to a selected instruction Provider;
// it cannot establish current human/session/agency or source-row ownership.
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

function checkedReceipt(access, configuration, targets) {
  const {receiptSha256, ...receipt} = structuredClone(targets);
  requireValue(receiptSha256 === hash(receipt), 'INVITATION_TARGET_RECEIPT_CHANGED', 'targets');
  const s = readSession(access, configuration, receipt);
  const manifest = validateTargetManifest(receipt.manifest);
  requireValue(manifest.rowsSha256 === rowsHash(manifest.rows), 'INVITATION_TARGET_RECEIPT_CHANGED', 'targets');
  return {receiptSha256, receipt, s, manifest};
}

function checkedSourceHandoff(access, configuration, targets, sourceHandoff) {
  const {handoffSha256, ...handoff} = structuredClone(sourceHandoff);
  requireValue(handoffSha256 === hash(handoff), 'INVITATION_SOURCE_HANDOFF_CHANGED', 'source');
  const checked = checkedReceipt(access, configuration, targets);
  requireValue(handoff.version === 1 && same(handoff.selection, checked.s.selection) &&
    handoff.configurationFingerprint === checked.s.configurationFingerprint &&
    handoff.targetReceiptSha256 === checked.receiptSha256 && same(handoff.request?.context, checked.s.selection) &&
    handoff.request?.capability === INVITATION_SOURCE && handoff.request?.version === '2' &&
    handoff.request?.inputKind === INVITATION_SOURCE_INPUT_KIND && same(handoff.request?.input, checked.manifest) &&
    handoff.requestSha256 === hash(handoff.request) && object(handoff.binding) && text(handoff.instructions),
  'INVITATION_SOURCE_HANDOFF_CHANGED', 'source');
  return {...checked, handoff};
}

export async function prepareEnvironmentInvitationSource({access, configuration, targets}) {
  const {receiptSha256, s, manifest} = checkedReceipt(access, configuration, targets);
  const request = {requestId:randomUUID(), capability:INVITATION_SOURCE, version:'2', context:s.selection,
    inputKind:INVITATION_SOURCE_INPUT_KIND, input:structuredClone(manifest)};
  const reply = await access.invoke(request);
  requireValue(same(s.selection, access.selection) && same(reply?.selection, s.selection),
    'INVITATION_SELECTION_MISMATCH', 'source');
  try { validateProviderResult(reply?.result, request); }
  catch (cause) { throw Object.assign(new TypeError('INVITATION_SOURCE_PROTOCOL_INVALID', {cause}), {
    code:'INVITATION_SOURCE_PROTOCOL_INVALID', stage:'source', reason:cause.message}); }
  requireValue(object(reply.binding) && ['packageName','packageVersion','bindingId','knowledgeVersion'].every(key => text(reply.binding[key])),
    'INVITATION_SOURCE_BINDING_INVALID', 'source');
  if (reply.result.status === 'failed') {
    throw Object.assign(new Error('INVITATION_SOURCE_FAILED'), {code:'INVITATION_SOURCE_FAILED', stage:'source',
      requestId:request.requestId, providerCode:reply.result.error.code, providerError:structuredClone(reply.result.error)});
  }
  requireValue(reply.result.status === 'interaction-required' && text(reply.result.instructions),
    'INVITATION_SOURCE_INSTRUCTIONS_INVALID', 'source');
  const handoff = {version:1, selection:s.selection, configurationFingerprint:s.configurationFingerprint,
    targetReceiptSha256:receiptSha256, request,
    binding:structuredClone(reply.binding), instructions:reply.result.instructions, requestSha256:hash(request)};
  return {...handoff, handoffSha256:hash(handoff)};
}

export async function prepareEnvironmentInvitationSourcePlan({access, configuration, targets, sourceHandoff, sourceResult, refinements = []}) {
  const {handoff} = checkedSourceHandoff(access, configuration, targets, sourceHandoff);
  requireValue(typeof access?.validateInstructionResult === 'function', 'INVITATION_SOURCE_VALIDATOR_MISSING', 'source');
  let validated;
  try { validated = await access.validateInstructionResult(handoff.request, structuredClone(sourceResult)); }
  catch (cause) { throw Object.assign(new TypeError('INVITATION_SOURCE_RESULT_INVALID', {cause}), {
    code:'INVITATION_SOURCE_RESULT_INVALID', stage:'source', reason:cause.message}); }
  requireValue(same(validated?.selection, handoff.selection) && same(validated?.binding, handoff.binding) &&
    same(access.selection, handoff.selection) && validated.verification === 'request-result-correlation-only',
  'INVITATION_SOURCE_BINDING_CHANGED', 'source');
  try { validateProviderResult(validated.result, handoff.request); }
  catch (cause) { throw Object.assign(new TypeError('INVITATION_SOURCE_RESULT_INVALID', {cause}), {
    code:'INVITATION_SOURCE_RESULT_INVALID', stage:'source', reason:cause.message}); }
  if (validated.result.status === 'failed') {
    throw Object.assign(new Error('INVITATION_SOURCE_FAILED'), {code:'INVITATION_SOURCE_FAILED', stage:'source',
      requestId:handoff.request.requestId, providerCode:validated.result.error.code, providerError:structuredClone(validated.result.error)});
  }
  requireValue(validated.result.status === 'done', 'INVITATION_SOURCE_RESULT_INCOMPLETE', 'source');
  try { validateInvitationEligibilityObservationsV2(validated.result.output); }
  catch (cause) { throw Object.assign(new TypeError('INVITATION_OBSERVATIONS_INVALID', {cause}), {
    code:'INVITATION_OBSERVATIONS_INVALID', stage:'source', reason:cause.message}); }
  const result = await prepareEnvironmentInvitationPlan({access, configuration, targets,
    observations:validated.result.output, refinements});
  const sourceProvenance = {requestSha256:handoff.requestSha256, binding:handoff.binding,
    resultSha256:hash(validated.result), verification:validated.verification};
  // Keep the established plan hash over the existing plan result. Provenance is
  // additive evidence for this source route, not a silent hash-scope change.
  return {...result, sourceProvenance};
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
  const {receiptSha256, s, manifest} = checkedReceipt(access, configuration, targets), c = s.config;
  observations = structuredClone(observations); refinements = structuredClone(refinements);
  try { validateInvitationEligibilityObservationsV2(observations); }
  catch (cause) { throw Object.assign(new TypeError('INVITATION_OBSERVATIONS_INVALID', {cause}), {
    code:'INVITATION_OBSERVATIONS_INVALID', stage:'observations', reason:cause.message}); }
  const live = await s.read(c.creators, c.creators.queries.all);
  const byId = new Map(creatorTargets(live, c.creators.fields.account).map(row => [row.creatorRecordId,row]));
  for (const row of manifest.rows) {
    const liveTarget = byId.get(row.creatorRecordId);
    requireValue(liveTarget && liveTarget.accountKey === normalizeAccountKey(row.accountKey),
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
    targetReceiptSha256:receiptSha256, observations, refinements, classification, plan,
    knownExistingIds:history.map(row => row.recordId).sort(), reads:s.reads,
    businessWorkflowVerified:false};
  return {...result, planSha256:hash(result)};
}


function checkedPlan(access, configuration, preparedPlan) {
  requireValue(object(preparedPlan), 'INVITATION_WRITE_PLAN_INVALID', 'write-prepare');
  const {planSha256, sourceProvenance, ...body} = structuredClone(preparedPlan);
  requireValue(planSha256 === hash(body) && body.status === 'prepared' && body.plan &&
    !hasBlockingRefreshIssues(body.plan), 'INVITATION_WRITE_PLAN_INVALID', 'write-prepare');
  readSession(access, configuration, body);
  return body;
}

async function freshPlan({access, configuration, targets, preparedPlan}) {
  checkedPlan(access, configuration, preparedPlan);
  const current = await prepareEnvironmentInvitationPlan({access, configuration, targets,
    observations:preparedPlan.observations, refinements:preparedPlan.refinements ?? []});
  requireValue(current.targetReceiptSha256 === preparedPlan.targetReceiptSha256 &&
    current.status === 'prepared' && same(current.plan, preparedPlan.plan) &&
    same(current.classification, preparedPlan.classification) &&
    same(current.knownExistingIds, preparedPlan.knownExistingIds) &&
    same(current.readIdentity, preparedPlan.readIdentity), 'INVITATION_WRITE_PLAN_STALE', 'write-prepare');
}

export function buildEnvironmentInvitationWriteInput({configuration, preparedPlan}) {
  const f = configuration.history.fields, plan = preparedPlan.plan;
  return {operation:'prepare', dataset:configuration.history.dataset, businessPlanSha256:preparedPlan.planSha256,
    plan:{creates:plan.creates.map(row => ({fields:Object.fromEntries(
      ['creatorRecordId','state','externalUserId','nickname','observedAtMs'].map(role => [f[role],row[role]])),
      ...(row.avatar ? {image:{field:f.avatarHashes,...structuredClone(row.avatar)}} : {})})),
    updates:plan.updates.map(row => ({recordId:row.recordId,fields:{[f.observedAtMs]:row.observedAtMs}})),
    attachments:plan.attachExisting.map(row => ({recordId:row.recordId,field:f.avatarHashes,image:structuredClone(row.avatar)})),
    knownExistingIds:structuredClone(preparedPlan.knownExistingIds)}};
}

async function writeRequest(access, selection, input, stage, execution) {
  requireValue(same(access.selection, selection), 'INVITATION_SELECTION_MISMATCH', stage);
  const request = {requestId:randomUUID(),capability:DATASET_WRITE,version:'1.0.0',context:structuredClone(selection),input};
  const reply = await access.invoke(request, execution);
  requireValue(same(access.selection, selection) && same(reply?.selection, selection), 'INVITATION_SELECTION_MISMATCH', stage);
  try { validateProviderResult(reply?.result,request); }
  catch (cause) { throw Object.assign(new TypeError('INVITATION_WRITE_PROTOCOL_INVALID',{cause}),{code:'INVITATION_WRITE_PROTOCOL_INVALID',stage}); }
  if (reply.result.status === 'failed') throw Object.assign(new Error('INVITATION_WRITE_FAILED'), {
    code:'INVITATION_WRITE_FAILED',stage,providerError:structuredClone(reply.result.error)});
  requireValue(reply.result.status === 'done', 'INVITATION_WRITE_UNCONFIRMED', stage);
  return structuredClone(reply.result.output);
}

export async function prepareEnvironmentInvitationWrite(args) {
  await freshPlan(args);
  const input = buildEnvironmentInvitationWriteInput(args);
  const result = await writeRequest(args.access, args.preparedPlan.selection, input, 'write-prepare');
  requireValue(result?.businessPlanSha256 === input.businessPlanSha256 &&
    /^[0-9a-f]{64}$/.test(result.intentSha256 ?? '') && same(result.selection,args.preparedPlan.selection) &&
    same(result.input,input), 'INVITATION_WRITE_PREPARE_INVALID', 'write-prepare');
  return result;
}

function checkPreparedWrite(args) {
  const {access,configuration,preparedPlan,preparedWrite} = args;
  checkedPlan(access,configuration,preparedPlan);
  requireValue(checkedReceipt(access,configuration,args.targets).receiptSha256 === preparedPlan.targetReceiptSha256,
    'INVITATION_TARGET_RECEIPT_CHANGED','write');
  requireValue(object(preparedWrite) && /^[0-9a-f]{64}$/.test(preparedWrite.intentSha256 ?? '') &&
    same(preparedWrite.selection,preparedPlan.selection) &&
    preparedWrite.businessPlanSha256 === preparedPlan.planSha256 &&
    same(preparedWrite.input,buildEnvironmentInvitationWriteInput(args)), 'INVITATION_WRITE_INTENT_INVALID','write');
}

async function verifyBusinessResult(args, result) {
  if (result.status !== 'confirmed') return result;
  const current = await prepareEnvironmentInvitationPlan({access:args.access,configuration:args.configuration,targets:args.targets,
    observations:args.preparedPlan.observations,refinements:args.preparedPlan.refinements ?? []});
  requireValue(same(current.readIdentity,args.preparedPlan.readIdentity) && current.status === 'prepared' &&
    !current.plan.creates.length && !current.plan.updates.length && !current.plan.attachExisting.length &&
    current.plan.alreadyApplied.length === current.plan.rowCount, 'INVITATION_WRITE_READBACK_FAILED','write-readback');
  return {...result,businessWorkflowVerified:true,readbackPlanSha256:current.planSha256};
}

export async function applyEnvironmentInvitationWrite(args) {
  checkPreparedWrite(args);
  requireValue(typeof args.execution?.authorizeIntent === 'function' && typeof args.execution?.onEvent === 'function',
    'INVITATION_WRITE_EXECUTION_REQUIRED','write-apply');
  await freshPlan(args);
  const result = await writeRequest(args.access,args.preparedWrite.selection,
    {operation:'apply',prepared:structuredClone(args.preparedWrite)},'write-apply',args.execution);
  requireValue(result?.status === 'confirmed','INVITATION_WRITE_UNCONFIRMED','write-apply');
  return verifyBusinessResult(args,result);
}

export async function reconcileEnvironmentInvitationWrite(args) {
  checkPreparedWrite(args);
  requireValue(Array.isArray(args.events),'INVITATION_WRITE_EVENTS_REQUIRED','write-reconcile');
  const result = await writeRequest(args.access,args.preparedWrite.selection,
    {operation:'reconcile',prepared:structuredClone(args.preparedWrite),events:structuredClone(args.events)},'write-reconcile');
  requireValue(['confirmed','missing','conflict','unknown'].includes(result?.status),'INVITATION_WRITE_RECONCILE_INVALID','write-reconcile');
  return verifyBusinessResult(args,result);
}
