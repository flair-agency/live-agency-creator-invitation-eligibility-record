import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRefreshPlan, buildRefreshPlanFromHistory, hasBlockingRefreshIssues } from '../scripts/invitation_state_core.mjs';
import { buildClassifiedInvitationRefreshPlan, buildClassifiedInvitationRefreshPlanFromHistory } from '../src/invitation-classification.mjs';

const time = Date.parse('2030-01-02T03:04:05Z');
const manifest = { version: 1, targetMode: 'selected', rowCount: 1,
  rows: [{ creatorRecordId: 'recCreator', accountKey: 'synthetic.creator' }] };
const observation = { observedAt: new Date(time).toISOString(), rowCount: 1,
  creators: [{ accountKey: 'synthetic.creator', state: 'synthetic-basic-child', externalUserId: 'synthetic-id', nickname: 'Synthetic' }] };
const state = { recordId: 'recHistory', creatorRecordId: 'recCreator', state: 'synthetic-basic-child',
  externalUserId: 'synthetic-id', nickname: 'Synthetic', observedAtMs: time - 1000, avatarHashes: [] };
const bindings = Object.fromEntries(['creator', 'status', 'observedAt', 'nickname', 'avatar', 'externalUserId'].map(key => [key, { name: key }]));
const record = { record_id: 'recHistory', fields: { creator: [{ record_ids: ['recCreator'] }],
  status: 'synthetic-basic-child', externalUserId: 'synthetic-id', nickname: 'Synthetic', observedAt: time - 1000, avatar: [] } };
const avatar = { path: '/private/synthetic.png', sha256: 'a'.repeat(64), size: 1, name: 'synthetic.png', mimeType: 'image/png' };

test('normalized and legacy inputs preserve transition, identity, avatar and timestamp decisions', async () => {
  const cases = [
    { bucket: 'creates', empty: true },
    { bucket: 'updates' },
    { bucket: 'creates', desired: { state: 'synthetic-premium-child' } },
    { bucket: 'identityConflicts', desired: { externalUserId: 'another-id' } },
    { bucket: 'alreadyApplied', timestamp: time },
    { bucket: 'attachExisting', timestamp: time, desired: { avatar } },
    { bucket: 'staleObservations', timestamp: time, desired: { state: 'synthetic-premium-child' } },
    { bucket: 'staleObservations', timestamp: time + 1000 },
    { bucket: 'ambiguousLatest', ambiguous: true },
    { bucket: 'updates', storedAvatar: true, desired: { avatar } },
  ];
  for (const scenario of cases) {
    const observations = structuredClone(observation);
    Object.assign(observations.creators[0], scenario.desired);
    const storedHistory = scenario.empty ? [] : [structuredClone(state)];
    const storedRecords = scenario.empty ? [] : [structuredClone(record)];
    if (scenario.timestamp) {
      storedHistory[0].observedAtMs = scenario.timestamp;
      storedRecords[0].fields.observedAt = scenario.timestamp;
    }
    if (scenario.ambiguous) {
      storedHistory.push({ ...state, recordId: 'recOther', state: 'synthetic-other' });
      storedRecords.push({ ...structuredClone(record), record_id: 'recOther', fields: { ...record.fields, status: 'synthetic-other' } });
    }
    if (scenario.storedAvatar) {
      storedHistory[0].avatarHashes = [avatar.sha256];
      storedRecords[0].fields.avatar = [{ syntheticHash: avatar.sha256 }];
    }
    const before = structuredClone({ observations, manifest, storedHistory, storedRecords });
    const legacy = await buildRefreshPlan({ observations, manifest, storedRecords, bindings,
      resolveAttachmentHash: async attachment => attachment.syntheticHash });
    const normalized = buildRefreshPlanFromHistory({ observations, manifest, storedHistory });
    assert.deepEqual(normalized, legacy, scenario.bucket);
    assert.equal(normalized[scenario.bucket].length, 1, scenario.bucket);
    assert.deepEqual({ observations, manifest, storedHistory, storedRecords }, before);
  }
});

test('invalid source history and malformed normalized rows remain blocking evidence', async () => {
  const invalidStored = [{ recordId: 'recInvalid', reason: 'stored state is invalid: recInvalid' }];
  const storedRecords = [{ record_id: 'recInvalid', fields: { ...record.fields, observedAt: 0 } }];
  const legacy = await buildRefreshPlan({ observations: observation, manifest, storedRecords, bindings });
  const normalized = buildRefreshPlanFromHistory({ observations: observation, manifest, storedHistory: [], invalidStored });
  assert.deepEqual(normalized, legacy);
  assert.equal(hasBlockingRefreshIssues(normalized), true);
  const before = structuredClone(invalidStored);
  const malformed = buildRefreshPlanFromHistory({ observations: observation, manifest, invalidStored,
    storedHistory: [state, { ...state, recordId: 'recMalformed', observedAtMs: NaN }, null] });
  assert.equal(malformed.updates.length, 1);
  assert.deepEqual(malformed.invalidStored[0], invalidStored[0]);
  assert.deepEqual(malformed.invalidStored.slice(1).map(row => row.recordId), ['recMalformed', '']);
  assert.equal(hasBlockingRefreshIssues(malformed), true);
  assert.deepEqual(invalidStored, before);
  assert.throws(() => buildRefreshPlanFromHistory({ observations: observation, manifest, storedHistory: null }), /arrays/);
});

test('classified normalized planning preserves category selection and existing plan output', async () => {
  const statuses = [{ id: 'root', label: 'synthetic-parent', parentId: null },
    { id: 'basic', label: 'synthetic-basic-child', parentId: 'root', invitationCategory: 'synthetic-basic' },
    { id: 'premium', label: 'synthetic-premium-child', parentId: 'root', invitationCategory: 'synthetic-premium' }];
  for (const category of ['synthetic-basic', 'synthetic-premium', null]) {
    const { state: ignored, ...identity } = observation.creators[0];
    const observations = { ...observation, contractVersion: 'invitation-eligibility-observations/v2',
      creators: [{ ...identity, result: 'observed', eligibility: 'synthetic-parent', invitationCategory: category }] };
    const legacy = await buildClassifiedInvitationRefreshPlan({ observations, manifest, statuses, storedRecords: [record], bindings });
    const normalized = buildClassifiedInvitationRefreshPlanFromHistory({ observations, manifest, statuses, storedHistory: [state] });
    assert.deepEqual(normalized, legacy);
    assert.equal(category === 'synthetic-basic' ? normalized.plan.updates.length : normalized.plan.creates.length, 1);
    const invalid = buildClassifiedInvitationRefreshPlanFromHistory({ observations, manifest, statuses, storedHistory: [state],
      invalidStored: [{ recordId: 'recRejected', reason: 'synthetic source rejection' }] });
    assert.equal(hasBlockingRefreshIssues(invalid.plan), true);
  }
});

test('unobserved classification stops before reading normalized history', () => {
  const statuses = [{ id: 'root', label: 'synthetic-parent', parentId: null }];
  for (const result of ['not_found', 'unavailable']) {
    const observations = { ...observation, contractVersion: 'invitation-eligibility-observations/v2',
      creators: [{ accountKey: 'synthetic.creator', result, eligibility: null, invitationCategory: null }] };
    const outcome = buildClassifiedInvitationRefreshPlanFromHistory({ observations, manifest, statuses, storedHistory: null });
    assert.equal(outcome.classification.blocked, true);
    assert.equal(outcome.plan, null);
  }
});
