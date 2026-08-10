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
- `checkout-history`: How the Git history for automatic cache-restore detection was obtained: `skipped`, `existing`, `deepened`, or `fresh`. `skipped` means history was not needed.
- `lock-file-changed`: Whether `MODULE.bazel.lock` changed: `true`, `false`, or `unknown` when the check was skipped.

### Triggers

PR and branch builds read from the cache but never write to it. Only builds on `main` populate it.

You need to use this action on branch builds to benefit from the cache, but it will not store anything. It will only store an updated cache on push to `main`.

That means: **if nothing builds on `main` after a merge, the cache stays stale.** Make sure your repo has a CI job that runs on every push to `main` — not just on pull requests.

If your default branch is not named `main`, pass `main-branch: <name>` to override.

### Required permissions

The job using this action needs:

```yaml
permissions:
  # When running with `skip-cache-restore: auto` (default), the action needs to read the repository contents to check for changes to `MODULE.bazel.lock`. If you set `skip-cache-restore` to `true` or `false`, this permission is not needed.
  contents: read

  # This action can delete stale cache entries when it saves a new cache. This is optional, and you can use the prune-cache action instead. Deleting caches requires `actions: write` permission.
  actions: write
```

## How it works

`skip-cache-restore: auto` is the default. In this mode, pull request and
branch builds always restore the cache. For builds on `main`, the action checks
whether the cache should be rebuilt or restored by comparing
`MODULE.bazel.lock` with the previous commit. If it has changed, the cache is
rebuilt; otherwise, it is restored. To make that comparison, the action needs
a checkout with history (depth 2). If no checkout is available, the action will
perform the checkout. If insufficient depth is available, the action will fetch
the missing history. If the checkout is available and has sufficient depth, the
action will use it to determine whether the cache should be rebuilt or
restored. If deepening an existing checkout fails, the action only falls back
to a fresh checkout when the workspace is clean. It fails rather than discard
tracked, untracked, or ignored files from a dirty workspace. In that case,
provide a checkout with `fetch-depth: 2` or set `skip-cache-restore` to `true`
or `false`.
