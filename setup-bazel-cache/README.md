# Setup Bazel Cache

Bazel builds can be slow. Caching helps — but only if the cache is set up correctly and stays small enough to be worth restoring. This action handles the setup so you don't have to.

## Usage

```yaml
steps:
  - uses: eclipse-score/cicd-actions/setup-bazel-cache@<sha>
    with:
      unique-cache-name: [${{ github.workflow }}-]${{ github.job }}[-<matrix-uid>]
      # Optional parameters with default values:
      main-branch: main
      skip-cache-restore: false
```

Parameters:

- unique-cache-name: A unique name for the cache. This is required to avoid conflicts between different jobs and workflows.
  Using `github.workflow` and `github.job` together gives each job its own cache automatically.
  Append a matrix identifier if the same job runs with different configurations that produce different build outputs.
  Omit `github.workflow` if you use `workflow_call` triggers and want to avoid nesting caches under the caller's workflow name.
- main-branch: The branch that is allowed to save the cache. Override if your default branch has a different name.
- skip-cache-restore: Whether to skip restoring the cache. Useful for rebuilding a fresh cache.

## Required permissions

The job using this action needs:

```yaml
permissions:
  actions: write
```

`actions: write` is required because deleting caches — which this action does to prune stale entries — is only available through the GitHub REST API. The internal runner token used for cache save and restore does not cover deletion; `GITHUB_TOKEN` with `actions: write` is the only supported mechanism for it.

## The cache only gets written from `main`

PR and branch builds read from the cache but never write to it. Only builds on `main` populate it.

That means: **if nothing builds on `main` after a merge, the cache stays stale.** Make sure your repo has a CI job that runs on every push to `main` — not just on pull requests.

If your default branch is not named `main`, pass `main-branch: <name>` to override.

## Big caches are slow caches

A cache that takes 2 minutes to restore and 2 minutes to save only helps if it saves more than 4 minutes of build time. Bazel caches tend to grow large over time, so it's worth keeping them in check:

- Give each job its own `unique-cache-name` and only build what that job actually needs. A focused cache is faster to restore and less likely to be evicted.
- GitHub evicts caches automatically when storage runs low — smaller caches survive longer.
- Check **Actions → Caches** in your repo occasionally. If an entry is several gigabytes, it's probably doing more harm than good.
