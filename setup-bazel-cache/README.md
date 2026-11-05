# Setup Bazel Cache

A GitHub Action for Linux workflows. It restores and saves Bazelisk, Bazel disk,
and downloaded repository caches. It can also cache large extracted external
repositories and report cache reuse. It does not configure a remote cache.

Use it when CI needs to reuse dependency downloads, preserve cache generations,
or show whether Bazel reused build and test results.

## Quick start

Run checkout first, then add the action before your Bazel commands. For reports
and profiling, the corresponding `bazel` or `bazelisk` executable must already
be available on `PATH` when the action runs.

```yaml
steps:
  - uses: actions/checkout@<sha>

  - uses: eclipse-score/cicd-actions/setup-bazel-cache@<sha>
    with:
      disk-cache-key: ${{ github.job }}

  - run: bazel test //...
```

Keep `disk-cache-key` stable between runs. Add matrix values when jobs need
separate disk caches. `github.job` can be used to share a cache across callers
of the same reusable workflow.

## Inputs

### Workspace selection

You do not need to split your builds into separate jobs. You can run this action
once at the start of a job, then build both the root module and a nested module.
Both builds use the configured disk and dependency-download caches. Setup uses
the root module's settings; it does not separately restore and save the nested
module's extracted dependencies.

If you choose to build a nested module in its own job, set `working-directory`
to that module's directory. This lets setup prepare the Bazel version used by
that module, check its own lockfile for dependency changes, and restore and save
its extracted dependencies. It is an optional way to improve caching for that
job, not a requirement for building nested modules.

For example, in a job that builds `examples/integration`:

```yaml
steps:
  - uses: actions/checkout@<sha>

  - uses: eclipse-score/cicd-actions/setup-bazel-cache@<sha>
    with:
      disk-cache-key: integration-linux
      working-directory: examples/integration

  - run: bazel test //...
    working-directory: examples/integration
```

Set the directory on both steps: the action's input selects which module to
prepare caches for; the run step's setting selects where Bazel runs. The action
defaults to `.` (the checkout root). Use one setup call per job; multiple calls
in the same job are not currently supported.

You still decide whether jobs share their disk cache:

- Use the same `disk-cache-key` in the root and nested jobs to share cached build
  results. This may avoid repeated build work, but jobs may download a larger
  cache archive.
- Use different keys to keep their disk caches separate. This can be useful for
  parallel jobs: each can save and clean up its own cache independently.

A later job can reuse a cache saved by an earlier job. Parallel jobs do not
automatically combine their new cache entries. Changing `working-directory`
does not force separate disk caches. Dependency downloads can still be reused
across jobs. See [cache behavior](./EXPLANATION.md#cache-restore-and-save) for
the details.

### Cache identity and publishing

- **`disk-cache-key`**
  - Options: Required string of 1–400 printable characters, without commas.

  Use a stable value to identify the disk cache for this job. Add matrix values
  when jobs need separate caches. For a matrix example, see
  [Use the action in a build matrix](./HOW-TO.md#use-the-action-in-a-build-matrix).

- **`cache-save-branch-patterns`**
  - Options: Empty (default), or newline-separated branch names and glob patterns.

  Empty allows only the repository's default branch to save. Set patterns to
  allow other branches, and include the default branch if it should remain
  allowed; pull-request refs and tags cannot save caches.

- **`token`**
  - Options: `${{ github.token }}` (default) or another GitHub token.

  Supply a token with `actions: write` if the action should remove obsolete
  disk or repository cache generations after an upload. Uploads work without
  that permission.

### Cache families

#### Disk cache

- **`disk-cache-restore`**
  - Options: `auto` (default), `true`, `false`.

  `auto` skips the existing cache when the module lockfile changed and this run
  may save. `true` always attempts restore; `false` skips it.

- **`disk-cache-save`**
  - Options: `true` (default), `false`.

  Set `false` to prevent disk-cache uploads from this job. Saving is still
  limited by the branch policy.

#### Downloaded repository cache

- **`repository-cache-restore`**
  - Options: `auto` (default), `true`, `false`.

  `auto` skips the old cache when `MODULE.bazel.lock` changed and this run may
  save, so the next generation starts with downloads for the new dependencies.
  `true` always attempts restore; `false` skips it. This setting does not
  control the separate extracted-repository cache. See
  [automatic restore behavior](./EXPLANATION.md#automatic-restore-and-save-decisions).

- **`repository-cache-save`**
  - Options: `auto` (default), `true`, `false`.

  `auto` seeds an empty or lockfile-reset cache and saves after the configured
  growth threshold. `true` saves every eligible non-empty run; `false` disables
  uploads.

- **`repository-cache-growth-threshold`**
  - Options: Integer from `0` to `100` (default: `10`).

  Used when `repository-cache-save` is `auto`. Set it to `0` to save after any
  positive growth, including small additions from flaky downloads.

#### Bazel version cache

- **`bazelisk-cache-restore`**
  - Options: `true` (default), `false`.

  Set `false` to download the selected Bazel version again instead of restoring
  it from cache.

- **`bazelisk-cache-save`**
  - Options: `true` (default), `false`.

  Set `false` to stop saving downloaded Bazel versions for later runs.

#### Extracted external repositories

- **`external-cache-restore`**
  - Options: `true` (default), `false`.

  Set `false` to skip restoring large extracted repositories under Bazel's
  output base.

- **`external-cache-save`**
  - Options: `true` (default), `false`.

  Set `false` to stop saving extracted repositories. These caches are saved
  only after a successful job.

### Reports and profiling

- **`report-cache-hits`**
  - Options: `true` (default), `false`.

  Set `false` to disable build/action cache reporting for `build`, `run`,
  `test`, and `coverage` invocations.

- **`report-test-cache-hits`**
  - Options: `true` (default), `false`.

  Set `false` to disable test-result reporting for `test` and `coverage`.
  Reporting does not enable Bazel's test-result cache.

- **`report-cache-step-summary`**
  - Options: `true`, `false` (default).

  Set `true` to also write enabled reports to the GitHub Actions step summary.

- **`enable-profiling`**
  - Options: `auto` (default), `true`, `false`.

  `auto` captures profiles when Actions debug logging is enabled; `true`
  captures profiles on every run and `false` disables profiling. Captured
  profiles are uploaded as a job artifact.

The [reference](./REFERENCE.md#inputs) covers detailed behavior and input
interactions.

## Outputs

| Output | Meaning |
| --- | --- |
| `cache-save-branch-evaluated` | `true` when this ref is allowed to save caches, otherwise `false`. |
| `bazelisk-cache-restored` | `true` when a Bazelisk cache was restored, otherwise `false`. |
| `disk-cache-restored` | `true` when a disk cache was restored, otherwise `false`. |
| `repository-cache-restored` | `true` when a downloaded repository cache was restored, otherwise `false`. |
| `external-cache-restored` | `true` when the manifest and every repository it lists were restored, otherwise `false`. |

## Choose a guide

- [How-to](./HOW-TO.md): use caches in a build matrix, warm a shared
  repository cache, and allow selected branches to publish.
- [Reference](./REFERENCE.md): input defaults, accepted values, outputs, and
  permissions.
- [Explanation](./EXPLANATION.md): how cache restore and save decisions work,
  what reports measure, and how cache storage is managed.
