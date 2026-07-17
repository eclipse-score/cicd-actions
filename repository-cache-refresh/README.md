# Repository cache refresh

## Description

Fetches Bazel dependencies for one or more configured variants to warm repository cache artifacts.

## Inputs

| Name | Mandatory | Default | Description |
| --- | --- | --- | --- |
| `variants` | Yes | - | Newline-separated list of `<config>|<targets>` entries. If `<config>` is empty (for example `|//...`), the action runs `bazel fetch <targets>` without `--config`. |

## Required permissions

This action calls GitHub cache APIs via `gh cache delete` and needs:

- `actions: read`
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
```
