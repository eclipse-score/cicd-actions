# Warm Bazel repository cache

## Description

Validates `variants` input and fetches Bazel dependencies for one or more configured variants to warm repository cache artifacts.

Set `dry-run: true` to run validation only (no `bazel fetch`).
This mode is safe for pull requests and merge queues.

## Inputs

| Name | Mandatory | Default | Description |
| --- | --- | --- | --- |
| `variants` | Yes | - | Newline-separated list of arguments to append to `bazel fetch`. Each line is split on whitespace and run as one `bazel fetch` invocation, for example `--config=x86_64-linux //...` or `//test //quality`. |
| `dry-run` | No | `false` | When `true`, only validates `variants` (single `--config=<name>` max per line, config exists in `.bazelrc`, and all targets resolve via `bazel query`) and skips cache warming. |

## Required permissions

This action needs:

- none

## Example

```yaml
- name: Validate repository cache variants
  uses: eclipse-score/cicd-actions/warm-bazel-repository-cache@main
  with:
    dry-run: true
    variants: |
      //src/tools/...
      --config=x86_64-linux //...
      --config=aarch64-linux //...

- name: Warm Bazel repository cache artifacts
  uses: eclipse-score/cicd-actions/warm-bazel-repository-cache@main
  with:
    variants: |
      //src/tools/...
      --config=x86_64-linux //...
      --config=aarch64-linux //...
      --config=x86_64-qnx //src/... //tests/...
      --config=aarch64-qnx //src/... //tests/...
```
