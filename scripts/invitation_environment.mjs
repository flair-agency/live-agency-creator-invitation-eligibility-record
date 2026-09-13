#!/usr/bin/env node
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isMainModule } from '@flair-agency/cli-utils/is-main';
import { readPrivateJson, readPrivateText, writePrivateJson } from '@flair-agency/private-files';
import { prepareEnvironmentInvitationTargets, prepareEnvironmentInvitationPlan, prepareEnvironmentInvitationSource, prepareEnvironmentInvitationSourcePlan } from '../src/invitation-environment.mjs';

export function parseArgs(argv) {
  const [operation, ...rest] = argv;
  const common = ['environment','generation','platform','configuration','configuration-sha256','output'];
  const allowed = {targets:[...common,'mode','account','limit'], plan:[...common,'targets','observations','refinements'],
    source:[...common,'targets'], 'source-plan':[...common,'targets','source-handoff','source-result','refinements']};
  if (!allowed[operation]) throw new TypeError('choose targets, plan, source, or source-plan');
  const args = {operation, accounts:[]};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].slice(2), value = rest[i + 1];
    if (!rest[i].startsWith('--') || !allowed[operation].includes(key) || !value || value.startsWith('--') ||
      (key !== 'account' && Object.hasOwn(args, key))) throw new TypeError('invalid or repeated argument');
    if (key === 'account') args.accounts.push(value); else args[key] = value;
  }
  const required = operation === 'plan' ? ['targets','observations'] : operation === 'source' ? ['targets'] :
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
  const inputs = ['environment','configuration','targets','observations','source-handoff','source-result','refinements'].filter(key => args[key]).map(key => path.resolve(args[key]));
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
  const result = args.operation === 'targets'
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

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
    const result = await run(args);
    console.log(JSON.stringify({status:result.status ?? (args.operation === 'source' ? 'interaction-required' : 'prepared'), output:args.output,
      targetCount:result.manifest?.rowCount, planSha256:result.planSha256, businessWorkflowVerified:false}));
    return result.status === 'blocked' ? 2 : 0;
  } catch (error) {
    // The private artifact retains the Provider's safe cause; stdout has no raw records or service response.
    const diagnostic = {status:'stopped', code:error.code ?? 'INVITATION_ENVIRONMENT_FAILED', stage:error.stage ?? 'environment',
      requestId:error.requestId, providerCode:error.providerCode, businessWorkflowVerified:false};
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
