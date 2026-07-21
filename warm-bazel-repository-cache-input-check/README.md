# Warm Bazel repository cache input check

## Description

Validates the `variants` input used by `warm-bazel-repository-cache` before a workflow tries to run `bazel fetch`.

Each non-empty line must contain:

- at most one `--config=<name>` option
- one or more Bazel targets
- no other command-line options

The action also verifies that:

- the referenced Bazel config exists in a discovered `.bazelrc` file
- each target resolves with `bazel query`

## Inputs

| Name | Mandatory | Default | Description |
| --- | --- | --- | --- |
| `variants` | Yes | - | Newline-separated list of arguments to validate. Each line may contain at most one `--config=<name>` option followed by one or more Bazel targets. |

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
```
