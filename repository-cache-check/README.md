# Repository cache check

## Description

Checks whether Bazel repository cache inputs changed in the current revision range.
If a refresh is needed, it captures the current cache IDs so they can be deleted later.

## Inputs

This action does not define any inputs.

## Outputs

| Name | Description |
| --- | --- |
| `should_refresh_cache` | `true` when repository cache should be refreshed, otherwise `false`. |
| `old-caches-json` | JSON string containing the list of existing cache IDs, or `[]` when no refresh is needed. |

## Required permissions

This action calls GitHub cache APIs via `gh cache list` and needs:

- `contents: read`

## Example

```yaml
- name: Check if repository cache refresh is needed
  id: check
  uses: eclipse-score/cicd-actions/repository-cache-check@main
```
