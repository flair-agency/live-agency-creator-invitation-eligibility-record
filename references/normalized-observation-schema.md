# Normalized invitation observations

## New eligibility-only input

```json
{
  "contractVersion": "invitation-eligibility-observations/v1",
  "observedAt": "2030-01-02T03:04:05.000Z",
  "rowCount": 1,
  "creators": [
    { "accountKey": "synthetic_creator", "result": "observed", "eligibility": "synthetic_eligible" }
  ]
}
```

The selected source must establish invitation-eligibility semantics. `eligibility`
is its opaque normalized eligibility value, not invitation progress, type,
membership or an agency scouting decision. An `observed` result requires a
nonempty value and the destination must contain that exact option. For
`not_found` or `unavailable`, `eligibility` must be `null`; never substitute an
ineligible option. The current selected runtime retains these results in a
blocked version 3 plan with zero proposed mutations; no destination mapping for
unknown outcomes has been adopted. One unknown creator blocks the whole batch.

Only the listed top-level fields are accepted. Creator rows additionally allow
the optional `externalUserId`, `nickname` and `avatar` described below. Unknown
fields, including `state` or sent-invitation progress, are rejected. Account
uniqueness uses NFKC, leading-@ removal, trimming and case folding. The exact
target set is still required for unavailable observations.

Call `dryRunEligibility` and `applyEligibilityReviewed` from the exported
`scripts/invitation_eligibility_runtime` module in the selected composition.
Supply `reviewHistory({ destination, records, recordsSha256 })`, a trusted
review callback that must return true for the actual history snapshot; uncertain
or mixed historical meaning stops the run without conversion. The callback is
not write authorization. Normal plan hash/count approval and selected Provider
authorization remain required. Version 2 plans are never automatically upgraded.

## Legacy structural input

```json
{
  "observedAt": "2030-01-02T03:04:05.000Z",
  "rowCount": 1,
  "creators": [
    {
      "accountKey": "synthetic_creator",
      "state": "synthetic_eligible",
      "externalUserId": "fixture-123",
      "nickname": "Synthetic Creator",
      "avatar": {
        "path": "/private/runtime/avatar.png",
        "sha256": "64-lowercase-hex-characters",
        "size": 1234,
        "name": "avatar.png",
        "mimeType": "image/png"
      }
    }
  ]
}
```

Rules:

- `observedAt` is the single timezone-aware ISO date-time timestamp for the
  complete set. Date-only and timezone-less values are invalid.
- `rowCount` equals `creators.length`.
- `accountKey` is non-empty and unique after normalization.
- `state` is a non-empty, provider-normalized value. The destination must have
  an exact single-select option with the same name.
- `externalUserId` and `nickname` are optional strings. Missing remains blank;
  the account key is not a nickname substitute.
- `avatar` is optional. When present, it refers to a private local image already
  downloaded and validated by the provider. The public plan retains the content
  hash and private path, never a source URL.
- Source-specific raw status values and mapping logic are outside this schema.

## Semantic admission

This legacy JSON shape validates structure only. For a new eligibility refresh,
the selected source contract must establish that `state` represents invitation
eligibility, not sent-invitation progress. Matching a destination option is not
semantic evidence. Preserve unavailable and not-found outcomes without mapping
them to ineligible. Ambiguous source meaning or an unrepresentable destination
outcome stops the workflow. Historical records are not automatically assigned
this meaning; inspect them under a selected read scope before any migration.
