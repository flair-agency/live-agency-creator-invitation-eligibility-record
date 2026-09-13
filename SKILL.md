---
name: live-agency-creator-invitation-eligibility-record
description: Prepare targets and record normalized invitation-eligibility observations with reviewed transition-history plans. Use for invitation eligibility refreshes; do not acquire source observations, track sent-invitation progress, send invitations, or compact history.
---

# Record invitation eligibility observations

Maintain transition-based invitation-status history without embedding knowledge
of the observation service. For a saved v2 environment, use the
[selected-environment read and plan workflow](references/environment-workflow.md).
It consumes logical datasets and reviewed private classification correspondence;
the selected datastore Provider owns service columns and their representations.
The legacy Lark client routes below remain compatibility paths.

## Adopted meaning and legacy history

For category-preserving planning, explicitly select the v2 normalized contract
and read [classification and evidence](references/invitation-classification.md).
The Provider supplies the observed parent eligibility and invitation category;
this Skill chooses a configured child only from that category or explicit
reviewed refinement evidence. The classification helper is pure planning;
`scripts/invitation_environment.mjs` connects selected-environment reads to that
same planning core. It provides `targets`, `source`, `source-plan` and the raw
normalized-input `plan`, with no write command.
Existing v1 routes remain compatible but cannot
preserve category and are insufficient for category-preserving migration acceptance.
For supplied normalized history, the reference also documents the pure
`buildClassifiedInvitationRefreshPlanFromHistory` entry; it requires no datastore
client or service field bindings.

New observations describe whether the platform permits an invitation at the
observation time. They do not describe the agency's scouting target decision,
sent-invitation progress or membership status. A separately observed invitation
category can refine the destination status without changing the parent meaning.

Require the selected source's reviewed contract to establish eligibility
semantics before admitting its output. A nonempty state string or a matching
destination option alone does not establish that meaning. Stop if the selected
source mixes eligibility with sent-invitation progress or leaves the meaning
unresolved. The legacy structural validator does not prove this distinction.

For a legacy explicit-client eligibility composition, use the explicit
`invitation-eligibility-observations/v1` input and
`scripts/invitation_eligibility_runtime.mjs`. Its version 3 plans bind the
destination and current fields as well as the original typed observations.
The trusted composition must supply `reviewHistory` and approve the meaning of
the actual history snapshot on every planning/apply/readback pass. A contract
tag or callback returning true without reviewed evidence is not that review.
Unknown outcomes are retained in a blocked plan until their destination
representation is separately established. The legacy helpers below remain
available for existing routes; do not use them to bypass new semantic admission.

For an explicitly selected client composition, prepare the complete review
payload with `buildInvitationHistoryWritePayloads` from
`scripts/invitation_lark_runtime.mjs`. It preserves timestamp updates, creates
with image metadata, and existing-row image resumes. Its bounded composition
supports at most 100 rows per operation; do not remove image effects or silently
split a larger approved plan to fit it. Bind the complete result to the same
reviewed business-plan hash through the selected destination Provider.
`applyEligibilityReviewed` remains the execution and final-readback entry point.

Preserve not-found and unavailable outcomes; never turn either into ineligible
or invent an eligible/ineligible value. If the destination cannot represent an
observed outcome without changing its meaning, stop and report the mapping gap.

Keep legacy history intact. Before using a legacy destination for this boundary,
inspect its meanings under an explicitly selected read scope. If meanings are
mixed or uncertain, present a migration proposal before refresh; do not convert,
delete, or relabel old states automatically. Existing plans and receipts are
not proof that old states represented eligibility.

For every Lark Base read or mutation, follow the policy supplied by the
installed Lark Base provider.
This skill's transition, approval, and avatar rules remain mandatory.

## Source boundary

For the saved v2 environment, follow the selected-environment workflow linked
above. Its `source` and `source-plan` entries ask Runtime for the selected
private v2 source instructions, preserve the correlated private handoff, and
admit only its v2 result before the existing planner. The host separately
confirms actor, session and agency; request/result correlation does not prove
live observation, identity or avatar ownership. The raw normalized-plan entry
remains available with narrower assurance and never promotes legacy state into
source evidence.

For legacy client routes, prepare the requested creator accounts from Lark,
then obtain observations in one of two ways:

1. accept normalized JSON conforming to
   [references/normalized-observation-schema.md](references/normalized-observation-schema.md); or
2. resolve exactly one installed `creator-invitation-observation-source/v1`
   provider from the direct npm dependencies of a local composition root.

Run `scripts/resolve_invitation_source.mjs` for a module provider. If the
resolver returns a private instruction provider, follow only those loaded
instructions and submit their result through the same normalized validator.
Never add provider package IDs, source URLs, UI labels, response codes, parsing
rules, or provider batch limits to this skill.

For unattended runs, continue only when the provider manifest declares
`unattended: true`. Authentication or human-interaction requirements stop an
unattended run rather than being bypassed. A scheduled run that resolves only
an interactive instruction provider must issue a concise reminder to start an
interactive observation run; it must not execute those instructions, silently
substitute another provider, or copy provider-specific steps into this public
skill.

## Refresh semantics

- Match every requested account exactly once after Unicode NFKC, leading `@`
  removal, trimming, and case folding. Reject missing, extra, or duplicate rows.
- Treat the classified `state` as an opaque normalized value. The selected v2
  route requires exact correspondence to the configured taxonomy; legacy Lark
  routes also require an exact option in their configured state field.
- Compare creator, exact state, external user ID, nickname, and avatar content.
  Ignore only the stored record ID and observation timestamp.
- When the newest stored state is identical, update only its timestamp.
- When the state differs, append one new state record.
- A nonblank observed external user ID conflicting with a nonblank historical ID
  for the creator is a stopping condition.
- Different states at the same latest timestamp are ambiguous and stop the run.
- Never update a historical state's content to make it match a new observation.

## Safety and authorization

Create a private dry-run plan and report its SHA-256, create count, timestamp
update count, avatar attachment count, already-applied count, conflicts, and
stale rows. Applying requires the user's explicit update authorization and exact
confirmation of the reviewed hash and counts immediately before mutation.

Before apply, reread creator accounts, due-view membership when applicable,
field definitions, status options, history, and avatar bytes. After apply,
reread again and require every observation to be already represented.

Do not send invitations, follow accounts, modify creator records, delete history,
or change fields other than creating an invitation-state row, extending the
latest identical row's timestamp, and attaching its observed avatar. History
compaction belongs to a separate explicit maintenance skill and is never part of
a scheduled refresh.

Use a private owner-only directory for target manifests, normalized
observations, avatar files, and plans. They contain creator identifiers. Never
commit or publish them.

## Migration verification and route selection

Verify the explicitly selected installed workflow through its planning,
approved execution and readback entry points. An MCP adapter is required only
when the selected client route uses it. Package and schema versions do not
select a production route. Reuse applicable Provider evidence and compare the
same reviewed inputs with a verified existing route when available; otherwise
use the business contract and independently established expected results.
Keep synthetic checks distinct from real-destination verification.

The following dual-run procedure applies only when explicitly comparing or
switching the legacy Creator Scouting MCP route. Do not introduce that route
as a prerequisite for another selected workflow. Passing a comparison or test
does not authorize mutations, activation, schedule changes or retirement of the
active route; preserve the selected recovery path until cutover acceptance.

For that legacy route's version 2 dual run, read
[references/v2-dual-run.md](references/v2-dual-run.md). Use the Creator Scouting
MCP to observe and validate invitation eligibility from the exact same reviewed
target manifest used by the version 1 path. Do not resolve a provider directly
on the version 2 side.

Compare target coverage, normalized values, proposed mutations, unavailable
values, and stop reasons with
`scripts/compare_invitation_v2_dual_run.mjs`. The comparison is dry-run only:
it cannot activate a write profile, change a schedule, or apply either plan.
Keep the version 1 route authoritative and available for rollback until a
separate invitation-history domain write route is active, route switching is
explicitly approved, and two scheduled version 2 cycles succeed.

Use these deterministic helpers:

- `scripts/export_invitation_targets.mjs --config CONFIG.json --output TARGETS.json`
- `scripts/resolve_invitation_source.mjs --provider-root ROOT --request REQUEST.json --output OBSERVATIONS.json`
- `scripts/sync_invitation_observations.mjs --config CONFIG.json --manifest TARGETS.json --observations OBSERVATIONS.json --output-plan PLAN.json`
- after explicit approval, `scripts/sync_invitation_observations.mjs --config CONFIG.json --plan PLAN.json --apply --expect-sha256 HASH --confirm-create N --confirm-update N --confirm-attach N --confirm-already-applied N`

The target exporter defaults to the configured due view. Use `--mode selected`
with repeated `--account` or `--mode all` only when the user explicitly asks to
refresh records regardless of the due view.

## Destination and credentials

Read [references/lark-config.md](references/lark-config.md) for the private
field-ID-only configuration. Resolve current field names from IDs at runtime.
Use batch APIs for approved creates and updates. On a provider limit, use only
the shared policy's exact import/browser fallback.

Use `LARK_TENANT_ACCESS_TOKEN`, `LARK_APP_ID` plus `LARK_APP_SECRET`, or an
explicit `LARK_KEYCHAIN_SERVICE`. Never put credential values in plans,
configuration, logs, or Git.
