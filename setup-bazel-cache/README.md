# Setup Bazel Cache

Bazel builds can be slow. Caching helps — but only if the cache is set up correctly and stays small enough to be worth restoring. This action handles the setup so you don't have to.

## Usage

### Syntax

```yaml
steps:
  - uses: eclipse-score/cicd-actions/setup-bazel-cache@<sha>
    with:
      unique-cache-name: [${{ github.workflow }}-]${{ github.job }}[-<matrix-uid>]
      # Optional parameters with default values:
      main-branch: main
      skip-cache-restore: auto
```

Parameters explained:

- `unique-cache-name`: A unique name for the cache. This is required to avoid conflicts between different jobs and workflows.
  Using `github.workflow` and `github.job` together gives each job its own cache automatically.
  Append a matrix identifier if the same job runs with different configurations that produce different build outputs.
  Omit `github.workflow` if you use `workflow_call` triggers and want to avoid nesting caches under the caller's workflow name.
- `main-branch`: The branch that is allowed to save the cache. Override if your default branch has a different name.
- `skip-cache-restore`: Whether to skip restoring the cache. Use `true` to always rebuild a clean cache, `false` to always restore it, or `auto` to rebuild it only on a cache-writing run when `MODULE.bazel.lock` changed (the default). PR and branch builds still restore the existing cache because they do not save a replacement.

Outputs:

- `skip-cache-restore`: The resolved cache-restore decision (`true` or `false`).
- `checkout-history`: How the Git history for automatic cache-restore detection was obtained: `skipped`, `existing`, or `deepened`. `skipped` means history was not needed.
- `lock-file-changed`: Whether `MODULE.bazel.lock` changed: `true`, `false`, or `unknown` when the check was skipped.

### Triggers

Use this action in every job where it should speed up a Bazel build, including
pull-request and branch jobs. Also run at least one such job on every push to
the default branch: only that run can refresh the shared cache after a merge.
The other jobs restore the latest cache but never replace it.

```yaml
on:
  pull_request:
  push:
    branches: [main]
```

If your default branch is not named `main`, pass `main-branch: <name>` to override.

### Required permissions

The job using this action needs:

```yaml
permissions:
  # When running with `skip-cache-restore: auto` (default), the action needs to read the repository contents to check for changes to `MODULE.bazel.lock`. If you set `skip-cache-restore` to `true` or `false`, this permission is not needed.
  contents: read
```

## How it works

The action configures a Bazel disk cache together with Bazelisk and repository
caches. The disk cache name comes from `unique-cache-name`.

Only a build running on `main` saves a cache. Pull-request and other branch
builds can restore that cache, but cannot replace it. This keeps untrusted or
short-lived branches from overwriting the shared cache.

### Automatic restore decision

`skip-cache-restore: auto` is the default. Branch builds always restore the
cache. On `main`, the action compares `MODULE.bazel.lock` with the previous
commit: it skips restore and rebuilds the cache when the lock file changed;
otherwise it restores the existing cache. Set `skip-cache-restore` to `true` or
`false` to always rebuild or always restore instead.

### Git history for automatic mode

The comparison on `main` needs the previous commit. The action uses an existing
checkout when it already has depth 2, or deepens a shallow checkout by one
commit when possible. It never checks out or clones a repository itself. When
the required history is unavailable, run `actions/checkout` with
`fetch-depth: 2` (or greater) before this action, or set `skip-cache-restore`
to `true` or `false`.
