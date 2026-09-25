import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyInvitationEligibilityObservations as classify, classifyInvitationEligibilityObservationsV3 as classifyV3, buildClassifiedInvitationRefreshPlan as build } from '../src/invitation-classification.mjs';
import { validateInvitationEligibilityObservations as v1, validateInvitationEligibilityObservationsV2 as v2, validateInvitationEligibilityObservationsV3 as v3 } from '../src/contracts.mjs';
const statuses = [
  {id:'root',label:'synthetic-parent',parentId:null},
  {id:'basic',label:'synthetic-basic-child',parentId:'root',invitationCategory:'synthetic-basic'},
  {id:'premium',label:'synthetic-premium-child',parentId:'root',invitationCategory:'synthetic-premium'},
  {id:'reviewed',label:'synthetic-reviewed-child',parentId:'root'},
  {id:'missing',label:'synthetic-displayed-missing',parentId:null},
];
const manifest = {version:1,targetMode:'selected',rowCount:1,rows:[{creatorRecordId:'recSynthetic',accountKey:'synthetic.creator'}]};
const snapshot = (category=null) => ({contractVersion:'invitation-eligibility-observations/v2',observedAt:'2030-01-02T03:04:05Z',rowCount:1,
  creators:[{accountKey:'synthetic.creator',result:'observed',eligibility:'synthetic-parent',invitationCategory:category,nickname:'Synthetic',externalUserId:'synthetic-id'}]});
const run = (observations=snapshot(), extra={}) => classify({observations,manifest,statuses,...extra});
test('category selects exact child; null retains parent without inferred refinement',()=>{
  assert.equal(run(snapshot('synthetic-basic')).observations.creators[0].state,'synthetic-basic-child');
  assert.equal(run().observations.creators[0].state,'synthetic-parent');
  const observations=snapshot(); observations.creators[0].avatar={path:'/private/synthetic.png',sha256:'a'.repeat(64),size:1,name:'synthetic.png',mimeType:'image/png'};
  const before=structuredClone(observations); const result=run(observations);
  assert.deepEqual(result.observations.creators[0].avatar,before.creators[0].avatar);
  assert.equal(result.observations.creators[0].nickname,'Synthetic');
  assert.equal(result.observations.creators[0].externalUserId,'synthetic-id');
  assert.deepEqual(observations,before);
  assert.equal(result.observations.contractVersion,undefined);
});
test('explicit reviewed child evidence is retained and cannot contradict category',()=>{
  const refinements=[{accountKey:'synthetic.creator',statusId:'reviewed',evidenceRef:'synthetic-evidence-1'}];
  const result=run(snapshot(),{refinements});
  assert.equal(result.observations.creators[0].state,'synthetic-reviewed-child');
  assert.equal(result.classifications[0].evidenceRef,'synthetic-evidence-1');
  assert.throws(()=>run(snapshot('synthetic-basic'),{refinements}),/conflicts/);
  for(const statusId of ['missing','root','unknown']) assert.throws(()=>run(snapshot(),{refinements:[{...refinements[0],statusId}]}),/child/);
  assert.throws(()=>run(snapshot(),{refinements:[{...refinements[0],evidenceRef:''}]}),/evidence/);
});
test('taxonomy rejects duplicates, indirect parents, ambiguous categories and unmappable values',()=>{
  for(const appended of [statuses[0],{id:'duplicate-label',label:statuses[0].label,parentId:null},
    {id:'orphan',label:'orphan',parentId:'absent'}, {id:'grandchild',label:'grandchild',parentId:'basic'},
    {id:'ambiguous',label:'ambiguous',parentId:'root',invitationCategory:'synthetic-basic'}]) {
    assert.throws(()=>run(snapshot(),{statuses:[...statuses,appended]}));
  }
  assert.throws(()=>run(snapshot('synthetic-unconfigured')),/category/);
  const observations=snapshot(); observations.creators[0].eligibility='synthetic-unconfigured';
  assert.throws(()=>run(observations),/root/);
});
test('displayed missing parent does not block other observations; acquisition failure remains blocked',async()=>{
  const observations=snapshot('synthetic-basic'); observations.creators.push({accountKey:'synthetic.other',result:'observed',eligibility:'synthetic-displayed-missing',invitationCategory:null}); observations.rowCount=2;
  const targets={...manifest,rowCount:2,rows:[...manifest.rows,{creatorRecordId:'recOther',accountKey:'synthetic.other'}]};
  assert.deepEqual(run(observations,{manifest:targets}).observations.creators.map(x=>x.state),['synthetic-basic-child','synthetic-displayed-missing']);
  for(const result of ['not_found','unavailable']) {
    observations.creators[1]={accountKey:'synthetic.other',result,eligibility:null,invitationCategory:null};
    const output=await build({observations,manifest:targets,statuses,storedRecords:null});
    assert.equal(output.classification.blocked,true); assert.equal(output.plan,null); assert.equal(output.classification.observations,null);
  }
});
test('exact targets, unique refinement accounts and v2 strict fields fail closed',()=>{
  const observations=snapshot(); observations.creators[0].accountKey='synthetic.other'; assert.throws(()=>run(observations),/exact target/);
  const refinement={accountKey:'synthetic.creator',statusId:'reviewed',evidenceRef:'e'};
  assert.throws(()=>run(snapshot(),{refinements:[refinement,refinement]}),/duplicate/);
  assert.throws(()=>run(snapshot(),{refinements:[{...refinement,accountKey:'synthetic.other'}]}),/scope/);
  for(const mutate of [x=>delete x.creators[0].invitationCategory,x=>x.creators[0].invitationCategory='',x=>x.creators[0].unexpected=true,
    x=>{x.creators[0].result='unavailable';x.creators[0].eligibility=null;x.creators[0].invitationCategory='synthetic-basic';}]) {
    const candidate=snapshot(); mutate(candidate); assert.throws(()=>v2(candidate));
  }
  const legacy=snapshot();legacy.contractVersion='invitation-eligibility-observations/v1';delete legacy.creators[0].invitationCategory;
  assert.equal(v1(legacy),legacy);assert.throws(()=>v2(legacy));assert.throws(()=>v1(snapshot()));
});
test('classification receipt detects taxonomy, category, evidence and target changes',()=>{
  const original=run();
  for(const changed of [run(snapshot('synthetic-basic')),run(snapshot(),{statuses:[...statuses,{id:'other',label:'other',parentId:null}]}),
    run(snapshot(),{refinements:[{accountKey:'synthetic.creator',statusId:'reviewed',evidenceRef:'e'}]}),
    run(snapshot(),{manifest:{...manifest,targetMode:'all'}})]) {
    assert.notEqual(changed.inputSha256,original.inputSha256);assert.notEqual(changed.receiptSha256,original.receiptSha256);
  }
});
test('existing history algorithm creates on category change and updates only timestamp for stable child',async()=>{
  const bindings=Object.fromEntries(['creator','status','observedAt','nickname','avatar','externalUserId'].map(key=>[key,{name:key}]));
  const storedRecords=[{record_id:'recHistory',fields:{creator:[{record_ids:['recSynthetic']}],status:'synthetic-basic-child',observedAt:Date.parse('2030-01-01T03:04:05Z'),nickname:'Synthetic',externalUserId:'synthetic-id',avatar:[]}}];
  const before=structuredClone({bindings,storedRecords});
  const stable=await build({observations:snapshot('synthetic-basic'),manifest,statuses,bindings,storedRecords});
  assert.equal(stable.plan.creates.length,0);assert.equal(stable.plan.updates.length,1);assert.equal(stable.plan.updates[0].recordId,'recHistory');
  const changed=await build({observations:snapshot('synthetic-premium'),manifest,statuses,bindings,storedRecords});
  assert.equal(changed.plan.creates.length,1);assert.equal(changed.plan.updates.length,0);assert.equal(changed.plan.creates[0].state,'synthetic-premium-child');
  assert.deepEqual({bindings,storedRecords},before);
});
test('v3 keeps an unknown raw reason out of classification, fails closed on unknown status, and requires an explicit compliance rule',()=>{
  const source = {contractVersion:'invitation-eligibility-observations/v3',observedAt:'2030-01-02T03:04:05Z',rowCount:1,
    creators:[{accountKey:'synthetic.creator',result:'observed',status:'synthetic-parent',reason:null,invitationCategory:null}]};
  assert.equal(v3(source),source);
  const unknownReason=structuredClone(source);unknownReason.creators[0].status='対象外';unknownReason.creators[0].reason='new source wording';
  const ineligibleStatuses=[...statuses,{id:'ineligible',label:'対象外',parentId:null}];
  assert.equal(classifyV3({observations:unknownReason,manifest,statuses:ineligibleStatuses}).blocked,false);
  const unknownStatus=structuredClone(source);unknownStatus.creators[0].status='unrecognized';assert.throws(()=>classifyV3({observations:unknownStatus,manifest,statuses}),/root/);
  const compliance=structuredClone(unknownReason);compliance.creators[0].reason='preserved';compliance.creators[0].complianceSignals=['multiple_account_risk'];
  assert.equal(classifyV3({observations:compliance,manifest,statuses:ineligibleStatuses}).blocked,true);
  const withRule=classifyV3({observations:compliance,manifest,statuses:[...ineligibleStatuses,{id:'risk',label:'risk-reviewed',parentId:'ineligible'}],complianceRules:[{signal:'multiple_account_risk',statusId:'risk',evidenceRef:'synthetic-policy'}]});
  assert.equal(withRule.blocked,false);assert.equal(withRule.observedReasons[0].reason,'preserved');assert.equal(withRule.observations.creators[0].state,'risk-reviewed');
  const legacy={...source,contractVersion:'invitation-eligibility-observations/v1',creators:[{accountKey:'synthetic.creator',result:'observed',eligibility:'その他の理由'}]};assert.equal(v1(legacy),legacy);
});
test('v3 unobserved rows remain blocked and carry no status or source-derived signals',()=>{
  for (const result of ['not_found','unavailable']) {
    const source={contractVersion:'invitation-eligibility-observations/v3',observedAt:'2030-01-02T03:04:05Z',rowCount:1,
      creators:[{accountKey:'synthetic.creator',result,status:null,reason:null,invitationCategory:null}]};
    assert.equal(v3(source),source);
    const receipt=classifyV3({observations:source,manifest,statuses});
    assert.equal(receipt.blocked,true);
    assert.equal(receipt.observations,null);
    assert.equal(receipt.issues[0].result,result);
    for (const changes of [{status:'synthetic-parent'},{reason:'unsupported reason'},{complianceSignals:['multiple_account_risk']}]) {
      const invalid=structuredClone(source);Object.assign(invalid.creators[0],changes);
      assert.throws(()=>v3(invalid));
    }
  }
});
test('v3 receipt hashes bind raw reasons, compliance signals and final blocked outcome',()=>{
  const source={contractVersion:'invitation-eligibility-observations/v3',observedAt:'2030-01-02T03:04:05Z',rowCount:1,
    creators:[{accountKey:'synthetic.creator',result:'observed',status:'synthetic-parent',reason:null,invitationCategory:null}]};
  const original=classifyV3({observations:source,manifest,statuses});
  const withReason=structuredClone(source);withReason.creators[0].status='対象外';withReason.creators[0].reason='first reason';
  const ineligibleStatuses=[...statuses,{id:'ineligible',label:'対象外',parentId:null}];
  const first=classifyV3({observations:withReason,manifest,statuses:ineligibleStatuses});
  withReason.creators[0].reason='second reason';
  const changed=classifyV3({observations:withReason,manifest,statuses:ineligibleStatuses});
  assert.notEqual(first.inputSha256,changed.inputSha256);
  assert.notEqual(first.receiptSha256,changed.receiptSha256);
  assert.notEqual(original.inputSha256,first.inputSha256);
  withReason.creators[0].complianceSignals=['multiple_account_risk'];
  const blocked=classifyV3({observations:withReason,manifest,statuses:ineligibleStatuses});
  const withRule=classifyV3({observations:withReason,manifest,statuses:[...ineligibleStatuses,{id:'risk',label:'risk-reviewed',parentId:'ineligible'}],
    complianceRules:[{signal:'multiple_account_risk',statusId:'risk',evidenceRef:'synthetic-policy'}]});
  assert.equal(blocked.blocked,true);assert.equal(withRule.blocked,false);
  assert.notEqual(changed.inputSha256,blocked.inputSha256);
  assert.notEqual(changed.receiptSha256,blocked.receiptSha256);
  assert.notEqual(blocked.inputSha256,withRule.inputSha256);
  assert.notEqual(blocked.receiptSha256,withRule.receiptSha256);
});

test('v3 preserves a reason under a configured status independent of its display label',()=>{
  const source={contractVersion:'invitation-eligibility-observations/v3',observedAt:'2030-01-02T03:04:05Z',rowCount:1,
    creators:[{accountKey:'synthetic.creator',result:'observed',status:'synthetic-parent',reason:'source detail',invitationCategory:null}]};
  assert.equal(v3(source),source);
  const classified=classifyV3({observations:source,manifest,statuses});
  assert.equal(classified.blocked,false);
  assert.equal(classified.observedReasons[0].reason,'source detail');
  assert.equal(classified.observations.creators[0].state,'synthetic-parent');
});

test('v3 coalesces compatible compliance rules and rejects conflicting targets',()=>{
  const source={contractVersion:'invitation-eligibility-observations/v3',observedAt:'2030-01-02T03:04:05Z',rowCount:1,
    creators:[{accountKey:'synthetic.creator',result:'observed',status:'synthetic-parent',reason:'source detail',invitationCategory:null,
      complianceSignals:['multiple_account_risk','other_agency_membership']}]};
  const rules=[
    {signal:'multiple_account_risk',statusId:'reviewed',evidenceRef:'policy-one'},
    {signal:'other_agency_membership',statusId:'reviewed',evidenceRef:'policy-two'},
  ];
  const compatible=classifyV3({observations:source,manifest,statuses,complianceRules:rules});
  assert.equal(compatible.blocked,false);
  assert.equal(compatible.classifications.length,1);
  assert.equal(compatible.classifications[0].statusId,'reviewed');
  assert.deepEqual(JSON.parse(compatible.classifications[0].evidenceRef),['policy-one','policy-two']);
  assert.throws(()=>classifyV3({observations:source,manifest,statuses,
    complianceRules:[rules[0],{...rules[1],statusId:'basic'}]}),/conflicting compliance target statuses/);
});
