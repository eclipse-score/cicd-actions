# Repository cache refresh

## Description

Fetches Bazel dependencies for one or more configured variants to warm repository cache artifacts.
After successful fetches, it deletes previously captured old caches.

## Inputs

| Name | Mandatory | Default | Description |
| --- | --- | --- | --- |
| `variants` | Yes | - | Newline-separated list of `<config>|<targets>` entries used for `bazel fetch --config=<config> <targets>`. |
| `old-caches-json` | Yes | `[]` | JSON string containing old cache IDs, as produced by `repository-cache-check`. |

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
      x86_64-linux|//...
      aarch64-linux|//...
      x86_64-qnx|//src/... //tests/...
      aarch64-qnx|//src/... //tests/...
    old-caches-json: ${{ steps.check.outputs['old-caches-json'] }}
```
