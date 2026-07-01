# Repository cache check

## Description

Checks whether Bazel repository cache inputs changed in the current revision range.
If a refresh is needed, it saves all current cache IDs to a JSON file so they can be deleted later.

## Inputs

| Name | Mandatory | Description |
| --- | --- | --- |
| `old-caches-json` | Yes | Output path where cache IDs are saved in JSON format. |

## Outputs

| Name | Description |
| --- | --- |
| `should_refresh_cache` | `true` when repository cache should be refreshed, otherwise `false`. |

## Required permissions

This action calls GitHub cache APIs via `gh cache list` and needs:

- `actions: write`
- `contents: read`

## Example

```yaml
- name: Check if repository cache refresh is needed
  id: check
  uses: eclipse-score/cicd-actions/repository-cache-check@main
  with:
    old-caches-json: ${{ github.workspace }}/.tmp/old_caches.json
```
