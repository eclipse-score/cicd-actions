# Warm Bazel repository cache

## Description

Fetches Bazel dependencies for one or more configured variants to warm repository cache artifacts.

For testing the `variants` input without modifying caches, run [`warm-bazel-repository-cache-input-check`](../warm-bazel-repository-cache-input-check/README.md) first.
This can be run in e.g. pull requests.

## Inputs

| Name | Mandatory | Default | Description |
| --- | --- | --- | --- |
| `variants` | Yes | - | Newline-separated list of arguments to append to `bazel fetch`. Each line is split on whitespace and run as one `bazel fetch` invocation, for example `--config=x86_64-linux //...` or `//test //quality`. |

## Required permissions

This action needs:

- none

## Example

```yaml
- name: Validate repository cache variants
  uses: eclipse-score/cicd-actions/warm-bazel-repository-cache-input-check@main
  with:
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
