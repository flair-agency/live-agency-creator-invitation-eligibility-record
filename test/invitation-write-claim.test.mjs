import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,realpath,readdir,unlink,readFile,link} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync,writeFileSync} from 'node:fs';
import {invitationWriteClaimStore} from '../scripts/invitation_write_claim.mjs';
const execute=promisify(execFile);

test('dataset claim excludes another process and survives caller-chosen journal changes',async t=>{
  const directory=await realpath(await mkdtemp(path.join(os.tmpdir(),'invitation-claims-')));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const environment=path.join(directory,'environment.json');await writeFile(environment,'{}',{mode:0o600});
  const store=await invitationWriteClaimStore({environment,dataset:'history'});
  const args={intentSha256:'a'.repeat(64),businessPlanSha256:'b'.repeat(64),journal:path.join(directory,'first.ndjson')};
  const attempt=await store.acquire(args);
  const child=async intent=>{
    const program=`import {invitationWriteClaimStore} from ${JSON.stringify(new URL('../scripts/invitation_write_claim.mjs',import.meta.url).href)};
      try { const store=await invitationWriteClaimStore({environment:process.argv[1],dataset:'history'});
        await store.acquire({intentSha256:process.argv[2],businessPlanSha256:'b'.repeat(64),journal:process.argv[3]});
        console.log('acquired'); } catch(error) { console.log(error.code); }`;
    return (await execute(process.execPath,['--input-type=module','-e',program,environment,intent,path.join(directory,'other.ndjson')])).stdout.trim();
  };
  assert.equal(await child('c'.repeat(64)),'INVITATION_WRITE_DATASET_LOCKED');
  await assert.rejects(store.reconcile(args),{code:'INVITATION_WRITE_ATTEMPT_ACTIVE'});
  await attempt.ready();
  await attempt.complete();
  assert.equal(await child(args.intentSha256),'INVITATION_WRITE_INTENT_CONSUMED');
  const second=await store.acquire({...args,intentSha256:'c'.repeat(64)});
  await second.ready();
  await second.stopped();
  const recovery=await store.reconcile({...args,intentSha256:'c'.repeat(64)});
  await recovery.finish('unknown');
  assert.equal(await child('d'.repeat(64)),'INVITATION_WRITE_DATASET_LOCKED');
  await recovery.finish('conflict');
  assert.equal(await child('d'.repeat(64)),'INVITATION_WRITE_DATASET_LOCKED');
  await recovery.finish('missing');
  assert.equal(await child('c'.repeat(64)),'INVITATION_WRITE_INTENT_CONSUMED');
  const residual=await store.acquire({...args,intentSha256:'d'.repeat(64)});await residual.complete();
});

test('dead initialization is recoverable without a journal; a running attempt still requires readback',async t=>{
  for(const phase of ['claim-only','initializing','linked-initializing','running','stopped-snapshot-race','completed-snapshot-race'])await t.test(phase,async t=>{
    const directory=await realpath(await mkdtemp(path.join(os.tmpdir(),'invitation-crash-')));
    t.after(()=>rm(directory,{recursive:true,force:true}));
    const environment=path.join(directory,'environment.json');await writeFile(environment,'{}',{mode:0o600});
    const args={intentSha256:'a'.repeat(64),businessPlanSha256:'b'.repeat(64),journal:path.join(directory,'absent.ndjson')};
    const program=`import {invitationWriteClaimStore} from ${JSON.stringify(new URL('../scripts/invitation_write_claim.mjs',import.meta.url).href)};
      const store=await invitationWriteClaimStore({environment:process.argv[1],dataset:'history'});
      const attempt=await store.acquire(JSON.parse(process.argv[2]));
      if(process.argv[3]==='running')await attempt.ready();
      process.exit(0);`;
    await execute(process.execPath,['--input-type=module','-e',program,environment,JSON.stringify(args),phase]);
    const stateDirectory=path.join(directory,'.invitation-write-state');
    const files=await readdir(stateDirectory);
    const activeFile=path.join(stateDirectory,files.find(name=>name.endsWith('.active.json')));
    const claimFile=path.join(stateDirectory,files.find(name=>name.endsWith('.claim.json')));
    assert.equal(JSON.parse(await readFile(activeFile,'utf8')).token,JSON.parse(await readFile(claimFile,'utf8')).token);
    if(phase==='linked-initializing') {
      // Model termination after atomic publication but before temp-link cleanup.
      await link(claimFile,claimFile+'.interrupted.tmp');
      await link(activeFile,activeFile+'.interrupted.tmp');
    }
    // Model the earlier durable boundary: claim published, active not yet linked.
    const noActive=['claim-only','completed-snapshot-race'].includes(phase);
    if(noActive)await unlink(activeFile);
    const store=await invitationWriteClaimStore({environment,dataset:'history'});
    await assert.rejects(store.reconcile({...args,journal:path.join(directory,'different.ndjson')}),{code:'INVITATION_WRITE_CLAIM_MISMATCH'});
    if(phase.endsWith('snapshot-race'))t.mock.method(process,'kill',()=>{
      // Advance the owner after the initial snapshots, just before death is
      // reported: reconciliation must use the newer durable running marker.
      const running={...JSON.parse(readFileSync(claimFile,'utf8')),state:'running'};
      writeFileSync(claimFile,JSON.stringify(running));
      if(!noActive)writeFileSync(activeFile,JSON.stringify({...running,state:'stopped'}));
      throw Object.assign(new Error('dead process'),{code:'ESRCH'});
    });
    const recovery=await store.reconcile(args);
    assert.equal(recovery.notStarted,['claim-only','initializing','linked-initializing'].includes(phase));
    await recovery.finish('unknown');
    if(!noActive)await assert.rejects(store.acquire({...args,intentSha256:'c'.repeat(64)}),{code:'INVITATION_WRITE_DATASET_LOCKED'});
    await recovery.finish('missing');
    await assert.rejects(store.acquire(args),{code:'INVITATION_WRITE_INTENT_CONSUMED'});
    const next=await store.acquire({...args,intentSha256:'c'.repeat(64)});await next.ready();await next.complete();
  });
});
