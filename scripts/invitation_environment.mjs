#!/usr/bin/env node
import path from 'node:path';
import {open, constants, lstat, realpath} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import {invitationWriteClaimStore} from './invitation_write_claim.mjs';
import { createHash } from 'node:crypto';
import { isMainModule } from '@flair-agency/cli-utils/is-main';
import { readPrivateJson, readPrivateText, writePrivateJson } from '@flair-agency/private-files';
import { prepareEnvironmentInvitationTargets, prepareEnvironmentInvitationPlan, prepareEnvironmentInvitationSource, prepareEnvironmentInvitationSourcePlan, prepareEnvironmentInvitationWrite, applyEnvironmentInvitationWrite, reconcileEnvironmentInvitationWrite } from '../src/invitation-environment.mjs';

export function parseArgs(argv) {
  const [operation, ...rest] = argv;
  const common = ['environment','generation','platform','configuration','configuration-sha256','output'];
  const allowed = {targets:[...common,'mode','account','limit'], plan:[...common,'targets','observations','refinements'],
    'write-prepare':[...common,'targets','prepared-plan'],
    'write-apply':[...common,'targets','prepared-plan','prepared-write','journal','expect-intent-sha256','expect-plan-sha256','confirm-create','confirm-update','confirm-attach','confirm-already-applied'],
    'write-reconcile':[...common,'targets','prepared-plan','prepared-write','journal'],
    source:[...common,'targets'], 'source-plan':[...common,'targets','source-handoff','source-result','refinements']};
  if (!allowed[operation]) throw new TypeError('choose targets, plan, source, source-plan, write-prepare, write-apply, or write-reconcile');
  const args = {operation, accounts:[]};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].slice(2), value = rest[i + 1];
    if (!rest[i].startsWith('--') || !allowed[operation].includes(key) || !value || value.startsWith('--') ||
      (key !== 'account' && Object.hasOwn(args, key))) throw new TypeError('invalid or repeated argument');
    if (key === 'account') args.accounts.push(value); else args[key] = value;
  }
  const required = operation.startsWith('write-') ? ['targets','prepared-plan',...(operation === 'write-prepare' ? [] : ['prepared-write','journal'])] : operation === 'plan' ? ['targets','observations'] : operation === 'source' ? ['targets'] :
    operation === 'source-plan' ? ['targets','source-handoff','source-result'] : [];
  for (const key of ['environment','configuration','output', ...required]) {
    if (!args[key] || !path.isAbsolute(args[key])) throw new TypeError(`${key} requires an absolute path`);
  }
  if (args.refinements && !path.isAbsolute(args.refinements)) throw new TypeError('refinements requires an absolute path');
  for (const key of ['generation','configuration-sha256']) if (!/^[0-9a-f]{64}$/.test(args[key] ?? '')) throw new TypeError(`${key} requires SHA-256`);
  if (operation === 'targets') {
    args.mode ??= 'due';
    args.limit = args.limit === undefined ? null : Number(args.limit);
    if (!['due','selected','all'].includes(args.mode) || (args.mode === 'selected' ? !args.accounts.length : args.accounts.length) ||
      (args.limit !== null && (!Number.isSafeInteger(args.limit) || args.limit < 1))) throw new TypeError('invalid target selection');
  }
  if (operation === 'write-apply') {
    for (const key of ['expect-intent-sha256','expect-plan-sha256']) if (!/^[0-9a-f]{64}$/.test(args[key] ?? '')) throw new TypeError(`${key} requires SHA-256`);
    for (const key of ['confirm-create','confirm-update','confirm-attach','confirm-already-applied']) {
      if (!/^(0|[1-9][0-9]*)$/.test(args[key] ?? '')) throw new TypeError(`${key} requires count`);
      args[key] = Number(args[key]);
      if (!Number.isSafeInteger(args[key])) throw new TypeError(`${key} requires safe count`);
    }
  }
  const inputs = ['prepared-plan','prepared-write','journal','environment','configuration','targets','observations','source-handoff','source-result','refinements'].filter(key => args[key]).map(key => path.resolve(args[key]));
  if (inputs.includes(path.resolve(args.output))) throw new TypeError('output must differ from inputs');
  return args;
}

function rejectDuplicateJsonMembers(source) {
  let index = 0;
  const whitespace = () => { while (/\s/.test(source[index] ?? '')) index += 1; };
  const string = () => {
    const start = index++;
    while (index < source.length) {
      if (source[index++] === '"') return JSON.parse(source.slice(start, index));
      if (source[index - 1] === '\\') index += 1;
    }
    throw new SyntaxError('unterminated JSON string');
  };
  const value = () => {
    whitespace();
    if (source[index] === '{') {
      index += 1; whitespace();
      const members = new Set();
      if (source[index] === '}') { index += 1; return; }
      while (true) {
        if (source[index] !== '"') throw new SyntaxError('JSON object key is invalid');
        const key = string();
        if (members.has(key)) throw Object.assign(new TypeError('INVITATION_CONFIGURATION_DUPLICATE_MEMBER'), {
          code:'INVITATION_CONFIGURATION_DUPLICATE_MEMBER', stage:'configuration'});
        members.add(key); whitespace();
        if (source[index++] !== ':') throw new SyntaxError('JSON object separator is invalid');
        value(); whitespace();
        if (source[index] === '}') { index += 1; return; }
        if (source[index++] !== ',') throw new SyntaxError('JSON object delimiter is invalid');
        whitespace();
      }
    }
    if (source[index] === '[') {
      index += 1; whitespace();
      if (source[index] === ']') { index += 1; return; }
      while (true) {
        value(); whitespace();
        if (source[index] === ']') { index += 1; return; }
        if (source[index++] !== ',') throw new SyntaxError('JSON array delimiter is invalid');
      }
    }
    if (source[index] === '"') { string(); return; }
    const start = index;
    while (index < source.length && !/[\s,\]}]/.test(source[index])) index += 1;
    if (start === index) throw new SyntaxError('JSON value is invalid');
  };
  value(); whitespace();
  if (index !== source.length) throw new SyntaxError('JSON trailing content is invalid');
}

export function parseInvitationEnvironmentConfiguration(source) {
  try {
    rejectDuplicateJsonMembers(source);
    return JSON.parse(source);
  } catch (error) {
    if (error.code === 'INVITATION_CONFIGURATION_DUPLICATE_MEMBER') throw error;
    throw Object.assign(new TypeError(`INVITATION_CONFIGURATION_INVALID: ${error.message}`), {
      code:'INVITATION_CONFIGURATION_INVALID', stage:'configuration'});
  }
}

export async function run(args, {createAccess} = {}) {
  const bytes = await readPrivateText(args.configuration);
  if (createHash('sha256').update(bytes).digest('hex') !== args['configuration-sha256']) {
    throw Object.assign(new Error('INVITATION_CONFIGURATION_CHANGED'), {code:'INVITATION_CONFIGURATION_CHANGED', stage:'configuration'});
  }
  const configuration = parseInvitationEnvironmentConfiguration(bytes);
  createAccess ??= (await import('@flair-agency/live-agency-runtime/environment')).createEnvironmentAccess;
  const access = await createAccess(args.environment, {expectedGeneration:args.generation, ...(args.platform ? {platform:args.platform} : {})});
  const targetReceipt = args.targets ? await readPrivateJson(args.targets) : null;
  const result = args.operation.startsWith('write-') ? await runWrite(args,{access,configuration,targets:targetReceipt},bytes) : args.operation === 'targets'
    ? await prepareEnvironmentInvitationTargets({access, configuration, mode:args.mode, selectedAccounts:args.accounts, limit:args.limit})
    : args.operation === 'source'
      ? await prepareEnvironmentInvitationSource({access, configuration, targets:targetReceipt})
      : args.operation === 'source-plan'
        ? await prepareEnvironmentInvitationSourcePlan({access, configuration, targets:targetReceipt,
          sourceHandoff:await readPrivateJson(args['source-handoff']), sourceResult:await readPrivateJson(args['source-result']),
          refinements:args.refinements ? await readPrivateJson(args.refinements) : []})
        : await prepareEnvironmentInvitationPlan({access, configuration, targets:targetReceipt,
          observations:await readPrivateJson(args.observations), refinements:args.refinements ? await readPrivateJson(args.refinements) : []});
  // Reject configuration changes during reads instead of presenting a mixed plan.
  if (await readPrivateText(args.configuration) !== bytes) {
    throw Object.assign(new Error('INVITATION_CONFIGURATION_CHANGED'), {code:'INVITATION_CONFIGURATION_CHANGED', stage:'configuration'});
  }
  await writePrivateJson(args.output, result);
  return result;
}

async function runWrite(args, context, configurationBytes) {
  const preparedPlan = await readPrivateJson(args['prepared-plan']);
  const parameters = {...context,preparedPlan};
  if (args.operation === 'write-prepare') return prepareEnvironmentInvitationWrite(parameters);
  const preparedWrite = await readPrivateJson(args['prepared-write']);
  parameters.preparedWrite = preparedWrite;
  const store = await invitationWriteClaimStore({environment:args.environment,dataset:context.configuration.history.dataset});
  if (args.operation === 'write-reconcile') {
    const recovery = await store.reconcile({intentSha256:preparedWrite.intentSha256,businessPlanSha256:preparedPlan.planSha256,journal:args.journal});
    if (recovery.notStarted) {
      await recovery.finish('missing');
      return {status:'missing',reason:'WRITE_NOT_STARTED',intentSha256:preparedWrite.intentSha256,businessWorkflowVerified:false};
    }
    const lines = (await readPrivateText(args.journal)).trim().split('\n');
    const entries = lines.map(line => JSON.parse(line));
    const header = entries.shift();
    if (header?.intentSha256 !== preparedWrite.intentSha256 || header?.businessPlanSha256 !== preparedPlan.planSha256) throw new TypeError('journal intent mismatch');
    const result = await reconcileEnvironmentInvitationWrite({...parameters,events:entries});
    await recovery.finish(result.status);
    return result;
  }
  const p = preparedPlan.plan;
  if (args['expect-intent-sha256'] !== preparedWrite.intentSha256 || args['expect-plan-sha256'] !== preparedPlan.planSha256 ||
    args['confirm-create'] !== p.creates.length || args['confirm-update'] !== p.updates.length ||
    args['confirm-attach'] !== p.attachExisting.length + p.creates.filter(row => row.avatar).length ||
    args['confirm-already-applied'] !== p.alreadyApplied.length) throw new TypeError('reviewed hash or counts differ');
  // The fixed environment store prevents replay across journals and processes.
  const directoryPath = path.dirname(args.journal), directoryStat = await lstat(directoryPath);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o777) !== 0o700 ||
    directoryStat.uid !== process.getuid() || await realpath(directoryPath) !== directoryPath) throw new TypeError('journal requires a canonical owner-only directory');
  const claim = await store.acquire({intentSha256:preparedWrite.intentSha256,businessPlanSha256:preparedPlan.planSha256,journal:args.journal});
  let journal;
  try {
    journal = await open(args.journal,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    await journal.writeFile(JSON.stringify({intentSha256:preparedWrite.intentSha256,businessPlanSha256:preparedPlan.planSha256})+'\n');
    await journal.sync();
    const directory = await open(path.dirname(args.journal),constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
    await claim.ready();
    const result = await applyEnvironmentInvitationWrite({...parameters,execution:{
      authorizeIntent:async actual => isDeepStrictEqual(actual,preparedWrite) &&
        await readPrivateText(args.configuration) === configurationBytes,
      onEvent:async event => { await journal.writeFile(JSON.stringify(event)+'\n'); await journal.sync(); },
    }});
    await claim.complete();
    return result;
  } catch (error) {
    try { await claim.stopped(); } catch (claimError) { error.claimEvidenceCode = claimError.code ?? 'CLAIM_PERSIST_FAILED'; }
    throw error;
  } finally { await journal?.close(); }
}

export async function main(argv = process.argv.slice(2), options = {}) {
  let args;
  try {
    args = parseArgs(argv);
    const result = await run(args, options);
    console.log(JSON.stringify({status:result.status ?? (args.operation === 'source' ? 'interaction-required' : 'prepared'), output:args.output,
      targetCount:result.manifest?.rowCount, planSha256:result.planSha256, intentSha256:result.intentSha256, businessWorkflowVerified:result.businessWorkflowVerified === true}));
    return ['blocked','missing','conflict','unknown'].includes(result.status) ? 2 : 0;
  } catch (error) {
    // The private artifact retains the Provider's safe cause; stdout has no raw records or service response.
    const diagnostic = {status:'stopped', code:error.code ?? 'INVITATION_ENVIRONMENT_FAILED', stage:error.stage ?? 'environment',
      requestId:error.requestId, providerCode:error.providerCode, claimEvidenceCode:error.claimEvidenceCode, businessWorkflowVerified:false};
    if (args?.output) {
      try { await writePrivateJson(args.output, {...diagnostic, reason:error.reason, filesystemCode:error.filesystemCode,
        ...(error.providerError ? {providerError:error.providerError} : {})}); }
      catch (evidenceError) { diagnostic.evidenceCode = evidenceError.code ?? 'DIAGNOSTIC_WRITE_FAILED'; }
    }
    console.error(JSON.stringify(diagnostic));
    return 2;
  }
}
if (isMainModule(import.meta.url)) process.exitCode = await main();
