# Repository cache refresh

## Description

Fetches Bazel dependencies for one or more configured variants to warm repository cache artifacts.
After successful fetches, it deletes previously captured old caches.

## Inputs

| Name | Mandatory | Default | Description |
| --- | --- | --- | --- |
| `variants` | Yes | - | Newline-separated list of `<config>|<targets>` entries. If `<config>` is empty (for example `|//...`), the action runs `bazel fetch <targets>` without `--config`. |
| `old-caches-json` | Yes | `[]` | JSON string containing old cache IDs, as produced by `repository-cache-check`. |
| `_skip_cache_delete` | No | `false` | Internal/debug input to skip deletion of the old caches after warming. Not part of the stable public API. |

## Required permissions

This action calls GitHub cache APIs via `gh cache delete` and needs:

- `actions: write`
- `contents: read`

## Example

```yaml
- name: Refresh Bazel repository cache artifacts
  uses: eclipse-score/cicd-actions/repository-cache-refresh@main
  with:
    variants: |
      |//src/tools/...
      x86_64-linux|//...
      aarch64-linux|//...
      x86_64-qnx|//src/... //tests/...
      aarch64-qnx|//src/... //tests/...
    old-caches-json: ${{ steps.check.outputs['old-caches-json'] }}
```
