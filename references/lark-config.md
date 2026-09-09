# Private Lark configuration

```json
{
  "appToken": "local-app-token",
  "creatorTableId": "local-table-id",
  "invitationStateTableId": "local-table-id",
  "dueViewId": "local-view-id",
  "fieldIds": {
    "creatorAccount": "field-id",
    "stateCreator": "field-id",
    "stateStatus": "field-id",
    "stateObservedAt": "field-id",
    "stateNickname": "field-id",
    "stateAvatar": "field-id",
    "stateExternalUserId": "field-id"
  }
}
```

All field IDs must be present and distinct. `dueViewId` is required for the
default due-only target mode. Display names are deliberately absent; resolve
them from field IDs at runtime.

The creator account field may be Text or Url. Text uses its exact stored value;
Url uses its visible text, never a guessed username parsed from its link. Other
field types stop. This supports an explicitly selected development table without
changing its existing field type.

Keep this organization-specific file outside the public repository. It contains
identifiers, not app credentials.
