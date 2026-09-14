import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
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
  await attempt.complete();
  assert.equal(await child(args.intentSha256),'INVITATION_WRITE_INTENT_CONSUMED');
  const second=await store.acquire({...args,intentSha256:'c'.repeat(64)});
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
