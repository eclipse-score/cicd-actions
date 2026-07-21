# Warm Bazel repository cache

## Description

Fetches Bazel dependencies for one or more configured variants to warm repository cache artifacts.

If the `variants` input is assembled dynamically or maintained centrally, run [`warm-bazel-repository-cache-input-check`](../warm-bazel-repository-cache-input-check/README.md) first to catch unknown configs, unsupported options, and invalid targets before starting the fetch loop.

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
