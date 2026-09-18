# Reference

This page documents the action's supported inputs, outputs, and workflow
requirements. For task recipes, see the [how-to guide](./HOW-TO.md). For cache
and report behavior, see the [explanation](./EXPLANATION.md).

## Requirements

- Linux runners
- Bazel 8.6 or newer
- Run `actions/checkout` before this action

## Inputs

Cache-saving inputs are still subject to the branch policy. A `true` save
setting does not allow pull-request refs or tags to publish caches. Restore and
save settings are independent.

### Cache identity and save policy

#### `disk-cache-key`

Required. Use a stable value for runs that should share a disk cache. The value
must contain 1–400 printable characters and cannot contain commas. Add matrix
dimensions when those jobs need separate disk caches; avoid per-run values
such as `github.run_id`. For a matrix example, see
[Use the action in a build matrix](./HOW-TO.md#use-the-action-in-a-build-matrix).

#### `cache-save-branch-patterns`

Optional newline-separated branch names or glob patterns. When empty, only the
repository's default branch may save. When set, the list replaces that default,
so include the default branch if it should remain allowed. Patterns match
branch names without a `refs/` prefix; pull-request refs and tags cannot save.
`*` matches within one path component and `**` can also match `/`.

#### `token`

Defaults to `${{ github.token }}`. The action uses this token to delete old
disk or downloaded-repository cache generations after a successful upload.
Deletion requires `actions: write`; cache uploads work without that
permission. See [branch publishing](./HOW-TO.md#allow-release-branches-to-publish-caches).

### Cache controls

#### `disk-cache-restore`

Defaults to `auto`; accepts `auto`, `true`, or `false`. `false` skips restore;
`true` attempts to restore the matching disk cache. With `auto`, the action
may skip an existing cache when `MODULE.bazel.lock` changed and this run is
allowed to save the disk cache. See [automatic restore behavior](./EXPLANATION.md#automatic-restore-and-save-decisions).

#### `disk-cache-save`

Defaults to `true`; accepts `true` or `false`. `false` disables disk-cache
uploads. Saving remains subject to the branch policy and the action's
post-step conditions.

#### `repository-cache-restore`

Defaults to `auto`; accepts `auto`, `true`, or `false`. Controls restore of
downloaded repository archives stored by Bazel's `--repository_cache`. With
`auto`, the action skips the existing archive when `MODULE.bazel.lock` changed
and this run may save the repository cache. See
[automatic restore behavior](./EXPLANATION.md#automatic-restore-and-save-decisions).

#### `repository-cache-save`

Defaults to `auto`; accepts `auto`, `true`, or `false`. With `auto`, a missing
or lockfile-reset cache is seeded, and a restored cache is saved after reaching
the configured `repository-cache-growth-threshold`. With `true`, every eligible
non-empty run can upload; `false` disables uploads. The threshold is a
percentage of the starting local cache size. Uploads still follow the branch
policy. See [cache restore and save](./EXPLANATION.md#cache-restore-and-save).

#### `repository-cache-growth-threshold`

Defaults to `10`; accepts an integer from `0` to `100`, as a percentage. It is
used only when `repository-cache-save` is `auto`. A value of `0` saves whenever
the local cache has any positive growth; it does not save an unchanged cache.
Use `repository-cache-save: true` to upload every eligible non-empty run.
See [cache restore and save](./EXPLANATION.md#cache-restore-and-save).

#### `bazelisk-cache-restore` and `bazelisk-cache-save`

Both default to `true` and accept `true` or `false`. They independently control
restoring and saving downloaded Bazel versions used by Bazelisk.

#### `external-cache-restore` and `external-cache-save`

Both default to `true` and accept `true` or `false`. They independently
control caching of large extracted repositories below Bazel's
`output_base/external`. Saving occurs only after a successful job and only real
directories of at least 500 MiB are eligible. See
[extracted external repositories](./EXPLANATION.md#extracted-external-repositories).

### Reports and profiling

#### `report-cache-hits`

Defaults to `true`; accepts `true` or `false`. Controls build/action cache
reporting for `build`, `run`, `test`, and `coverage` invocations.

#### `report-test-cache-hits`

Defaults to `true`; accepts `true` or `false`. Controls test-result cache
reporting for `test` and `coverage` invocations. Reporting observes Bazel's
test-result cache behavior; it does not enable it.

#### `report-cache-step-summary`

Defaults to `true`; accepts `true` or `false`. When enabled, the cache overview
is written to both the job log and the GitHub Actions step summary. When false,
the log report remains enabled according to the two report inputs above.

#### `enable-profiling`

Defaults to `auto`; accepts `auto`, `true`, or `false`. `auto` captures profiles
when GitHub Actions debug logging is enabled. `true` enables profiling for
every measured invocation; `false` disables it. Profiles are uploaded as a job
artifact when at least one measured invocation produces one.

## Outputs

| Output | Values | Meaning |
| --- | --- | --- |
| `cache-save-branch-evaluated` | `true`, `false` | Whether this ref matches the configured cache-save branch policy |
| `bazelisk-cache-restored` | `true`, `false` | Whether a Bazelisk cache was restored by exact key or restore prefix |
| `disk-cache-restored` | `true`, `false` | Whether a disk cache was restored by exact key or restore prefix |
| `repository-cache-restored` | `true`, `false` | Whether a downloaded repository cache was restored by exact key or restore prefix |
| `external-cache-restored` | `true`, `false` | Whether the external-cache manifest and every repository it lists were restored |

Restore outputs are `false` when restore is disabled or no matching cache is
available. Outputs whose names begin with `_` are internal diagnostics and are
not part of the supported workflow interface.

## Permissions

- `contents: read` allows checkout and access to repository history used for
  automatic disk and repository cache restore decisions.
- `actions: write` allows deletion of a replaced cache generation after a
  successful upload. Uploads do not require this permission.

## Report coverage

When reporting is enabled, the action measures Bazel commands invoked through
its normal `bazel` or `bazelisk` launcher on `PATH`:

| Report | Commands |
| --- | --- |
| Build/action cache | `build`, `run`, `test`, `coverage` |
| Test-result cache | `test`, `coverage` |
| Profile | `build`, `run`, `test`, `coverage` |

`report-cache-hits` and `report-test-cache-hits` control the corresponding
reports. Profiling follows `enable-profiling`. The [explanation](./EXPLANATION.md#reports)
covers metric definitions and reporting limits.
