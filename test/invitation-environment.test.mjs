import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { prepareEnvironmentInvitationTargets as targets, prepareEnvironmentInvitationPlan as plan, prepareEnvironmentInvitationSource as source, prepareEnvironmentInvitationSourcePlan as sourcePlan } from '../src/invitation-environment.mjs';
import { buildClassifiedInvitationRefreshPlanFromHistory } from '../src/invitation-classification.mjs';
import { parseArgs, parseInvitationEnvironmentConfiguration, run } from '../scripts/invitation_environment.mjs';
import { exportTargets } from '../scripts/invitation_lark_runtime.mjs';

const selection = {environmentId:'test',environmentKind:'development',platformId:'synthetic',generation:'a'.repeat(64)};
const binding = {packageName:'@synthetic/reader',packageVersion:'1.0.0',bindingId:'dataset-read',knowledgeVersion:'1'};
const configuration = {schemaVersion:1,environment:{environmentId:'test',environmentKind:'development',platformId:'synthetic'},
  creators:{dataset:'people',queries:{all:'everyone',due:'pending'},fields:{account:'handle'}},
  statuses:{dataset:'taxonomy',query:'all',fields:{label:'title',parent:'parent'}},
  history:{dataset:'history',query:'byPerson',fields:{creatorRecordId:'person',state:'status',externalUserId:'uid',nickname:'name',observedAtMs:'time',avatarHashes:'images'}},
  categories:[{statusId:'child',invitationCategory:'category-one'}]};
const root = {recordId:'parent',values:{title:'eligible-example',parent:null}};
const child = {recordId:'child',values:{title:'eligible-example/one',parent:'parent'}};
const person = (id,handle) => ({recordId:id,values:{handle}});
const observedAt = '2026-09-13T00:00:00Z', time = Date.parse(observedAt);
function observations(accounts = ['one'], extra = {}) {
  return {contractVersion:'invitation-eligibility-observations/v2',observedAt,rowCount:accounts.length,
    creators:accounts.map(accountKey => ({accountKey,result:'observed',eligibility:'eligible-example',invitationCategory:'category-one',externalUserId:'u1',nickname:'Name',...extra}))};
}
function fixture({people = [person('p1',' @ＯＮＥ '),person('p2','two')], history = [], due = people, intercept, sourceIntercept} = {}) {
  const calls = [], access = {selection:structuredClone(selection),async invoke(request) {
    calls.push(structuredClone(request));
    if (request.capability === 'creator-invitation-observation-source/v2') {
      const reply = {selection:structuredClone(selection), binding:{packageName:'@synthetic/source',packageVersion:'1.0.0',bindingId:'source',knowledgeVersion:'1'},
        result:{requestId:request.requestId,capability:request.capability,version:request.version,context:structuredClone(request.context),status:'interaction-required',instructions:'synthetic private instruction'}};
      await sourceIntercept?.(reply,request);
      return reply;
    }
    const {input,...identity} = request;
    const rows = input.dataset === 'people' ? (input.query === 'pending' ? due : people) : input.dataset === 'taxonomy' ? [root,child] : history;
    const reply = {selection:structuredClone(selection),binding:structuredClone(binding),result:{...identity,status:'done',output:{
      dataset:input.dataset,query:input.query,scope:input.parameters,selection:structuredClone(selection),configurationFingerprint:'b'.repeat(64),complete:true,rows:structuredClone(rows)}}};
    await intercept?.(reply,request);
    return reply;
  }, async validateInstructionResult(request,result) {
    assert.equal(request.capability,'creator-invitation-observation-source/v2');
    return {selection:structuredClone(selection),binding:{packageName:'@synthetic/source',packageVersion:'1.0.0',bindingId:'source',knowledgeVersion:'1'},
      result:structuredClone(result),verification:'request-result-correlation-only'};
  }};
  return {access,configuration:structuredClone(configuration),calls};
}
async function one(f) { return targets({...f,mode:'selected',selectedAccounts:['one']}); }

test('selected source handoff preserves exact receipt and only admits correlated v2 output before datastore reads',async t=>{
  const f=fixture(), receipt=await one(f), handoff=await source({...f,targets:receipt});
  assert.equal(handoff.request.capability,'creator-invitation-observation-source/v2');
  assert.equal(handoff.request.version,'2'); assert.deepEqual(handoff.request.input,receipt.manifest);
  const result={requestId:handoff.request.requestId,capability:handoff.request.capability,version:'2',context:handoff.request.context,
    status:'done',output:observations()};
  const prepared=await sourcePlan({...f,targets:receipt,sourceHandoff:handoff,sourceResult:result});
  assert.equal(prepared.status,'prepared'); assert.equal(prepared.sourceProvenance.verification,'request-result-correlation-only');
  const bad={...result,requestId:'wrong'}; const before=f.calls.length;
  await assert.rejects(sourcePlan({...f,targets:receipt,sourceHandoff:handoff,sourceResult:bad}),{code:'INVITATION_SOURCE_RESULT_INVALID'});
  assert.equal(f.calls.length,before);
  const wrongContract={...result,output:{...result.output,contractVersion:'invitation-eligibility-observations/v1'}};
  await assert.rejects(sourcePlan({...f,targets:receipt,sourceHandoff:handoff,sourceResult:wrongContract}),{code:'INVITATION_OBSERVATIONS_INVALID'});
  assert.equal(f.calls.length,before);
  const changed=fixture(); changed.access.selection.generation='c'.repeat(64);
  await assert.rejects(sourcePlan({...changed,targets:receipt,sourceHandoff:handoff,sourceResult:result}),{code:'INVITATION_TARGET_RECEIPT_CHANGED'});
  const stale=fixture(); stale.access.validateInstructionResult=async (_request,value)=>({selection:structuredClone(selection),
    binding:{packageName:'@synthetic/source',packageVersion:'1.0.0',bindingId:'stale',knowledgeVersion:'1'},result:value,verification:'request-result-correlation-only'});
  await assert.rejects(sourcePlan({...stale,targets:receipt,sourceHandoff:handoff,sourceResult:result}),{code:'INVITATION_SOURCE_BINDING_CHANGED'});
});

test('source instructions reject an uncorrelated reply and retain a safe provider failure',async()=>{
  const receipt=await one(fixture());
  let f=fixture({sourceIntercept:(reply)=>{reply.result.requestId='wrong';}});
  await assert.rejects(source({...f,targets:receipt}),{code:'INVITATION_SOURCE_PROTOCOL_INVALID'});
  f=fixture({sourceIntercept:(reply)=>{reply.result.status='failed'; delete reply.result.instructions;
    reply.result.error={code:'AUTH_FAILED',message:'authentication failed',details:{stage:'session'}};}});
  await assert.rejects(source({...f,targets:receipt}),error=>{
    assert.equal(error.code,'INVITATION_SOURCE_FAILED'); assert.equal(error.providerCode,'AUTH_FAILED');
    assert.equal(error.providerError.details.stage,'session'); return true;
  });
});

test('target modes preserve normalization, selected order and limit; uniqueness precedes limiting',async()=>{
  const f = fixture();
  assert.deepEqual((await targets({...f,mode:'all'})).manifest.rows.map(r=>r.accountKey),['one','two']);
  assert.deepEqual((await targets({...f,mode:'selected',selectedAccounts:['two','@ONE'],limit:1})).manifest.rows,
    [{creatorRecordId:'p2',accountKey:'two'}]);
  assert.equal((await targets({...f,mode:'due'})).manifest.rowCount,2);
  const bad = fixture({people:[person('p1','one'),person('p2','@ＯＮＥ')]});
  await assert.rejects(targets({...bad,mode:'all',limit:1}),{code:'INVITATION_CREATOR_AMBIGUOUS'});
  for (const selectedAccounts of [['one','@ONE'],['absent']]) await assert.rejects(targets({...f,mode:'selected',selectedAccounts}));
  const many=fixture({people:Array.from({length:101},(_,i)=>person(`p${i}`,`a${i}`))});
  assert.equal((await targets({...many,mode:'all'})).manifest.rowCount,101);
});

test('new target manifests agree with the actual legacy target selector for all modes',async()=>{
  const f=fixture();
  const fieldIds={creatorAccount:'account',stateCreator:'owner',stateStatus:'status',stateObservedAt:'time',
    stateNickname:'name',stateAvatar:'image',stateExternalUserId:'uid'};
  const types={account:'Text',owner:'DuplexLink',status:'SingleSelect',time:'DateTime',name:'Text',image:'Attachment',uid:'Text'};
  const client={async listFields(){return Object.entries(types).map(([id,ui_type])=>({field_id:id,field_name:id,ui_type}));},
    async listRecords(){return [person('p1',' @ＯＮＥ '),person('p2','two')].map(row=>({record_id:row.recordId,fields:{account:row.values.handle}}));}};
  for(const options of [{mode:'due'}, {mode:'all',limit:1}, {mode:'selected',selectedAccounts:['two','@ONE']}]) {
    const old=await exportTargets({client,config:{fieldIds},...options});
    const fresh=(await targets({...f,...options})).manifest;
    for(const key of ['targetMode','rowCount','rows','rowsSha256']) assert.deepEqual(fresh[key],old[key]);
  }
  const original=client.listRecords;
  client.listRecords=async()=>[...(await original()),{record_id:'p3',fields:{account:'ＯＮＥ'}}];
  await assert.rejects(exportTargets({client,config:{fieldIds},mode:'all',limit:1}),/duplicated/);
  await assert.rejects(targets({...fixture({people:[person('p1','one'),person('p3','ＯＮＥ')]}),mode:'all',limit:1}),{code:'INVITATION_CREATOR_AMBIGUOUS'});
});

test('selected history is requested by IDs and passed unchanged to adopted classification and planning',async()=>{
  const historic = {recordId:'h1',values:{person:'p1',status:'eligible-example/one',uid:'u1',name:'Name',time:time-1000,images:[]}};
  const f=fixture({history:[historic]}), t=await one(f), obs=observations();
  const actual=await plan({...f,targets:t,observations:obs});
  const expected=buildClassifiedInvitationRefreshPlanFromHistory({manifest:t.manifest,observations:obs,
    statuses:[{id:'parent',label:root.values.title,parentId:null},{id:'child',label:child.values.title,parentId:'parent',invitationCategory:'category-one'}],
    storedHistory:[{recordId:'h1',creatorRecordId:'p1',state:historic.values.status,externalUserId:'u1',nickname:'Name',observedAtMs:time-1000,avatarHashes:[]}]});
  assert.deepEqual(actual.plan,expected.plan);
  assert.deepEqual(actual.classification,expected.classification);
  assert.equal(actual.plan.updates.length,1);
  assert.equal(actual.status,'prepared');
  assert.equal(actual.businessWorkflowVerified,false);
  assert.deepEqual(f.calls.at(-1).input,{dataset:'history',query:'byPerson',parameters:{recordIds:['p1']}});
});

test('due membership and target identity are rechecked; zero targets make zero history requests',async()=>{
  const f=fixture(), t=await targets({...f,mode:'due',limit:1});
  const expired=fixture({due:[]});
  const p=await plan({...expired,targets:t,observations:observations()});
  assert.equal(p.status,'blocked'); assert.equal(p.plan.staleObservations[0].reason,'creator is no longer due');
  await assert.rejects(plan({...fixture({people:[person('p1','renamed')]}),targets:t,observations:observations()}),{code:'INVITATION_TARGET_CHANGED'});
  const empty=fixture({people:[]});
  const result=await plan({...empty,targets:await targets({...empty,mode:'all'}),observations:observations([])});
  assert.equal(result.status,'prepared');
  assert.equal(empty.calls.filter(r=>r.input.dataset==='history').length,0);
});

test('planning rechecks normalized account uniqueness across every live creator before history reads',async()=>{
  const f=fixture(), t=await one(f);
  const changed=fixture({people:[person('p1','one'),person('p2','@ＯＮＥ')]});
  await assert.rejects(plan({...changed,targets:t,observations:observations()}),{code:'INVITATION_CREATOR_AMBIGUOUS'});
  assert.equal(changed.calls.filter(r=>r.input.dataset==='history').length,0);
});

test('failed, partial, uncorrelated and changed-configuration reads never become empty success',async t=>{
  for (const [name,modify,code] of [
    ['failure',r=>{r.result.status='failed';delete r.result.output;r.result.error={code:'AUTH_FAILED',message:'authentication failed',details:{stage:'token'}};},'INVITATION_DATASET_READ_FAILED'],
    ['partial',r=>{r.result.output.complete=false;},'INVITATION_READ_INCOMPLETE'],
    ['scope',r=>{r.result.output.scope={recordIds:['other']};},'INVITATION_READ_INCOMPLETE'],
    ['correlation',r=>{r.result.requestId='other';},'INVITATION_READ_PROTOCOL_INVALID'],
    ['generation',r=>{r.selection.generation='c'.repeat(64);},'INVITATION_SELECTION_MISMATCH'],
  ]) await t.test(name,async()=>{
    const f=fixture({intercept:modify});
    await assert.rejects(one(f),error=>{
      assert.equal(error.code,code);
      if(name==='failure') { assert.equal(error.providerCode,'AUTH_FAILED');assert.equal(error.providerError.details.stage,'token'); }
      return true;
    });
  });
  const f=fixture(), target=await one(f);
  const changed=fixture({intercept:r=>{r.result.output.configurationFingerprint='c'.repeat(64);}});
  await assert.rejects(plan({...changed,targets:target,observations:observations()}),{code:'INVITATION_READ_CONFIGURATION_CHANGED'});
  f.configuration.categories=[];
  await assert.rejects(plan({...f,targets:target,observations:observations()}),{code:'INVITATION_TARGET_RECEIPT_CHANGED'});
});

test('out-of-scope references stop, invalid stored history remains blocked, image failure is not no-image',async()=>{
  const row={recordId:'h1',values:{person:'other',status:'x',uid:'',name:'',time,images:[]}};
  let f=fixture({history:[row]});
  await assert.rejects(plan({...f,targets:await one(f),observations:observations()}),{code:'INVITATION_HISTORY_SCOPE_INVALID'});
  row.values.person='p1'; row.values.time='invalid'; f=fixture({history:[row]});
  const result=await plan({...f,targets:await one(f),observations:observations()});
  assert.equal(result.status,'blocked'); assert.equal(result.plan.invalidStored.length,1);
  row.values.time=time; row.values.images=null; f=fixture({history:[row]});
  assert.equal((await plan({...f,targets:await one(f),observations:observations()})).status,'blocked');
  row.values.images=['not-a-content-hash']; f=fixture({history:[row]});
  const invalidHash=await plan({...f,targets:await one(f),observations:observations()});
  assert.equal(invalidHash.status,'blocked'); assert.match(invalidHash.plan.invalidStored[0].reason,/content hash/);
});

test('original avatar bytes are verified before planning and a wrong digest stops before history reads',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'invitation-avatar-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'image.png'), bytes=Buffer.from('synthetic original'); await writeFile(file,bytes);
  const avatar={path:file,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),name:'image.png',mimeType:'image/png'};
  const f=fixture(), target=await one(f);
  assert.equal((await plan({...f,targets:target,observations:observations(['one'],{avatar})})).plan.creates[0].avatar.sha256,avatar.sha256);
  const count=f.calls.filter(r=>r.input.dataset==='history').length;
  await assert.rejects(plan({...f,targets:target,observations:observations(['one'],{avatar:{...avatar,sha256:'0'.repeat(64)}})}),{code:'INVITATION_AVATAR_INVALID'});
  assert.equal(f.calls.filter(r=>r.input.dataset==='history').length,count);
});

test('unresolved observations retain classification diagnostics without acquiring history',async()=>{
  const f=fixture({intercept:(reply,request)=>{
    if(request.input.dataset==='history') assert.fail('classification must stop history acquisition');
  }});
  const p=await plan({...f,targets:await one(f),observations:observations(['one'],{result:'unavailable',eligibility:null,invitationCategory:null})});
  assert.equal(p.status,'blocked'); assert.equal(p.plan,null);
  assert.equal(p.classification.issues[0].result,'unavailable');
});

test('CLI requires pinned explicit inputs, writes private receipt and detects configuration drift',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'invitation-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const conf=path.join(dir,'configuration.json'), out=path.join(dir,'targets.json');
  const bytes=JSON.stringify(configuration); await writeFile(conf,bytes,{mode:0o600});
  const args=['targets','--environment',path.join(dir,'environment.json'),'--generation',selection.generation,'--configuration',conf,
    '--configuration-sha256',createHash('sha256').update(bytes).digest('hex'),'--output',out,'--mode','selected','--account','one'];
  const parsed=parseArgs(args),f=fixture();
  const result=await run(parsed,{createAccess:async(_path,opts)=>{assert.equal(opts.expectedGeneration,selection.generation);return f.access;}});
  assert.equal(result.manifest.rowCount,1);
  for(const extra of [['--mode','all'],['--apply','true'],['--limit','0']]) assert.throws(()=>parseArgs([...args,...extra]));
  await writeFile(conf,bytes+'\n');
  await assert.rejects(run(parsed,{createAccess:async()=>assert.fail('configuration mismatch must precede Runtime')}),{code:'INVITATION_CONFIGURATION_CHANGED'});
});

test('CLI source operations require private target, handoff, and result paths',()=>{
  const base=['--environment','/private/environment.json','--generation',selection.generation,'--configuration','/private/configuration.json',
    '--configuration-sha256','b'.repeat(64),'--output','/private/output.json'];
  assert.equal(parseArgs(['source',...base,'--targets','/private/targets.json']).operation,'source');
  assert.equal(parseArgs(['source-plan',...base,'--targets','/private/targets.json','--source-handoff','/private/handoff.json','--source-result','/private/result.json']).operation,'source-plan');
  assert.throws(()=>parseArgs(['source-plan',...base,'--targets','/private/targets.json','--source-handoff','/private/handoff.json']));
});

test('private correspondence JSON rejects duplicate members before parsing, including escaped equivalents',()=>{
  assert.throws(() => parseInvitationEnvironmentConfiguration('{"outer":{"member":1,"member":2}}'),
    {code:'INVITATION_CONFIGURATION_DUPLICATE_MEMBER'});
  assert.throws(() => parseInvitationEnvironmentConfiguration('{"outer":{"a":1,"\\u0061":2}}'),
    {code:'INVITATION_CONFIGURATION_DUPLICATE_MEMBER'});
  assert.deepEqual(parseInvitationEnvironmentConfiguration('{"first":{"member":1},"second":{"member":2}}'),
    {first:{member:1},second:{member:2}});
});
