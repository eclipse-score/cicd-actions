# Repository cache check

## Description

Checks whether Bazel repository cache inputs changed in the current revision range.

## Inputs

This action does not define any inputs.

## Outputs

| Name | Description |
| --- | --- |
| `should_refresh_cache` | `true` when repository cache should be refreshed, otherwise `false`. |

## Required permissions

This action needs:

- `contents: read`

## Example

```yaml
- name: Check if repository cache refresh is needed
  id: check
  uses: eclipse-score/cicd-actions/repository-cache-check@main
```
