import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {open,constants,lstat,realpath,mkdir,unlink,link} from 'node:fs/promises';
import {writePrivateJson} from '@flair-agency/private-files';

function check(ok,code) {
  if(!ok)throw Object.assign(new Error(code),{code,stage:'write-claim'});
}
async function syncDirectory(directory) {
  const handle=await open(directory,constants.O_RDONLY);
  try {await handle.sync();}finally{await handle.close();}
}
async function privateDirectory(directory) {
  const stat=await lstat(directory);
  check(stat.isDirectory()&&!stat.isSymbolicLink()&&(stat.mode&0o777)===0o700&&stat.uid===process.getuid(),
    'INVITATION_WRITE_STORE_INVALID');
}
async function createExclusive(file,value) {
  // Publish only complete, synced JSON. A crash while writing leaves an unused
  // private temporary file, never an empty active lock or permanent claim.
  const temporary=file+'.'+randomUUID()+'.tmp';
  const handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try {
    try {await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync();}finally{await handle.close();}
    await link(temporary,file);
    await syncDirectory(path.dirname(file));
  } finally {await unlink(temporary);}
}
async function readState(file) {
  // These internal files use atomic hard-link publication. A killed publisher
  // can leave its private temporary link, unlike ordinary private JSON inputs.
  const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=await handle.stat();
    check(stat.isFile()&&[1,2].includes(stat.nlink)&&stat.uid===process.getuid()&&
      (stat.mode&0o777)===0o600&&stat.size>0&&stat.size<=65536,'INVITATION_WRITE_LOCK_INVALID');
    return JSON.parse(await handle.readFile('utf8'));
  } finally {await handle.close();}
}
function processAlive(pid) {
  check(Number.isSafeInteger(pid)&&pid>0,'INVITATION_WRITE_LOCK_INVALID');
  try {process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;return true;}
}

// The selected environment's canonical location owns this store. Caller-chosen
// evidence paths cannot choose a different claim or dataset execution lock.
export async function invitationWriteClaimStore({environment,dataset}) {
  const environmentPath=await realpath(environment),parent=path.dirname(environmentPath);
  await privateDirectory(parent);
  check(typeof dataset==='string'&&dataset.length>0,'INVITATION_WRITE_STORE_INVALID');
  const directory=path.join(parent,'.invitation-write-state');
  try {await mkdir(directory,{mode:0o700});await syncDirectory(parent);}catch(error){if(error.code!=='EEXIST')throw error;}
  await privateDirectory(directory);
  const scope=createHash('sha256').update(JSON.stringify([environmentPath,dataset])).digest('hex');
  const activePath=path.join(directory,scope+'.active.json');
  const claimPath=intent=>{
    check(/^[0-9a-f]{64}$/.test(intent??''),'INVITATION_WRITE_INTENT_INVALID');
    return path.join(directory,scope+'.'+intent+'.claim.json');
  };
  async function active() {
    try {return await readState(activePath);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  }
  async function release(expected) {
    // Serialize token-check plus unlink so two reconcilers cannot remove a later attempt's lock.
    const guard=path.join(directory,scope+'.release.json');
    try {await createExclusive(guard,{token:expected.token,pid:process.pid});}
    catch(error){if(error.code==='EEXIST')check(false,'INVITATION_WRITE_RELEASE_LOCKED');throw error;}
    try {
      const current=await active();
      check(current?.token===expected.token&&current.intentSha256===expected.intentSha256,'INVITATION_WRITE_LOCK_CHANGED');
      await unlink(activePath);await syncDirectory(directory);
    } finally {await unlink(guard);await syncDirectory(directory);}
  }
  return {
    async acquire({intentSha256,businessPlanSha256,journal}) {
      const claim={version:1,scope,intentSha256,businessPlanSha256,journal,token:randomUUID(),pid:process.pid,state:'initializing'};
      const intentPath=claimPath(intentSha256);
      check(!(await active()),'INVITATION_WRITE_DATASET_LOCKED');
      // The durable claim precedes the active lock, so any published lock has
      // matching recovery evidence even if the acquiring process is killed.
      try {await createExclusive(intentPath,claim);}catch(error){
        if(error.code==='EEXIST')check(false,'INVITATION_WRITE_INTENT_CONSUMED');throw error;
      }
      try {await createExclusive(activePath,claim);}catch(error){
        if(error.code==='EEXIST') {
          await unlink(intentPath);await syncDirectory(directory);
          check(false,'INVITATION_WRITE_DATASET_LOCKED');
        }
        throw error;
      }
      return {
        async ready(){
          const current=await active();
          check(current?.token===claim.token&&current.state==='initializing','INVITATION_WRITE_LOCK_CHANGED');
          const running={...claim,state:'running'};
          await writePrivateJson(intentPath,running);await syncDirectory(directory);
          await writePrivateJson(activePath,running);await syncDirectory(directory);
        },
        async complete(){await release(claim);},
        async stopped(){
          const current=await active();
          check(current?.token===claim.token,'INVITATION_WRITE_LOCK_CHANGED');
          await writePrivateJson(activePath,{...claim,state:current.state==='initializing'?'not-started':'stopped'});
          await syncDirectory(directory);
        },
      };
    },
    async reconcile({intentSha256,businessPlanSha256,journal}) {
      const claim=await readState(claimPath(intentSha256));
      check(claim.scope===scope&&claim.intentSha256===intentSha256&&claim.businessPlanSha256===businessPlanSha256&&claim.journal===journal,
        'INVITATION_WRITE_CLAIM_MISMATCH');
      const current=await active();
      let notStarted=claim.state==='initializing';
      if(current) {
        check(current.token===claim.token&&current.intentSha256===intentSha256,'INVITATION_WRITE_DATASET_LOCKED');
        check(['stopped','not-started'].includes(current.state)||
          (['running','initializing'].includes(current.state)&&!processAlive(current.pid)),'INVITATION_WRITE_ATTEMPT_ACTIVE');
        notStarted=['initializing','not-started'].includes(current.state);
      } else if(notStarted) {
        check(!processAlive(claim.pid),'INVITATION_WRITE_ATTEMPT_ACTIVE');
      }
      if(notStarted) {
        // The owner may have progressed after our first snapshots and exited
        // before the PID check. Its durable running marker must win over the
        // stale initializing snapshot, even if complete() removed active.
        const latest=await readState(claimPath(intentSha256));
        check(['scope','intentSha256','businessPlanSha256','journal','token','pid'].every(key=>latest[key]===claim[key]),
          'INVITATION_WRITE_CLAIM_MISMATCH');
        notStarted=latest.state==='initializing';
      }
      return {notStarted,async finish(status){if(current&&['confirmed','missing'].includes(status))await release(current);}};
    },
  };
}
