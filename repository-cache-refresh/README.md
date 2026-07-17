# Repository cache refresh

## Description

Fetches Bazel dependencies for one or more configured variants to warm repository cache artifacts.
After successful fetches, it deletes previously captured old caches.

## Inputs

| Name | Mandatory | Default | Description |
| --- | --- | --- | --- |
| `variants` | Yes | - | Newline-separated list of arguments to append to `bazel fetch`. Each line is split on whitespace and run as one `bazel fetch` invocation, for example `--config=x86_64-linux //...` or `//test //quality`. |
| `old-caches-json` | Yes | - | JSON string containing old cache IDs, as produced by `repository-cache-check`. |
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
      //src/tools/...
      --config=x86_64-linux //...
      --config=aarch64-linux //...
      --config=x86_64-qnx //src/... //tests/...
      --config=aarch64-qnx //src/... //tests/...
    old-caches-json: ${{ steps.check.outputs['old-caches-json'] }}
```
