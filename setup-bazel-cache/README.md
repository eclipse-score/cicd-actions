# Setup Bazel Cache

This Linux-only action configures Bazelisk, Bazel disk, and Bazel repository
caches with opinionated defaults for Bazel 8.6 or newer. Branch and
pull-request jobs restore caches; only configured cache-saving branches save
them. If no cache-save branch patterns are configured, the repository's default
branch is used automatically.

The action supports Linux runners only.

## Usage

```yaml
steps:
  - uses: actions/checkout@<sha>

  - uses: eclipse-score/cicd-actions/setup-bazel-cache@<sha>
    with:
      disk-cache-key: ${{ github.workflow }}-${{ github.job }}
      # Optional:
      cache-save-branch-patterns: |
        master
        release/*
```

- `disk-cache-key` separates disk caches belonging to different jobs or
  matrix configurations. It must be a stable value; do not include transient
  values such as `${{ github.run_id }}`.
- `cache-save-branch-patterns` is an optional newline-separated list of branch
  glob patterns allowed to save caches. An empty input uses the repository's GitHub
  default branch.
  Globbing: `*` matches within one branch path component and `**` also crosses `/`,
  so `release/*` matches `release/1.0` and `release/**` matches `release/1/0` and `release/2.0`.

### Advanced

Further parameters to configure cache behavior:
- `token` is optional and defaults to `${{ github.token }}`. It is only used to
  remove the previous repository- or disk-cache generation after a successful
  upload by this action.
- `bazelisk-cache-restore` and `bazelisk-cache-save` accept `true` or `false`.
  Both default to `true`; saving is still limited to configured cache-saving
  branches. `repository-cache-restore` accepts `true` or `false`, while
  `repository-cache-save` accepts `true`, `false`, or `auto` and defaults to
  `auto`. With `auto`, the repository cache is seeded after a miss and is
  uploaded again when its local payload grows by at least 10% during the job;
  the previous generation is then removed on a best-effort basis.
  `disk-cache-save` accepts `true` or `false`, and
  `disk-cache-restore` additionally accepts `auto`.
  Bazelisk uses the readable `.bazelversion` value in its exact cache key, so
  its cache is independent of `MODULE.bazel.lock`. For the disk and repository
  caches, restore `false` skips the restore. For disk-cache-restore, `auto`
  starts a fresh cache on a cache-saving branch when `MODULE.bazel.lock` changed;
  other refs restore the latest available cache.
  Save inputs only take effect on configured cache-saving branches; `false`
  disables saving for that cache.

## Cache security

GitHub makes default-branch caches readable from pull-request workflows,
including workflows triggered by forks. Do not allow Bazel's disk or repository
cache to contain secrets, credentials, private dependencies, or other artifacts
that pull-request authors must not be able to read.

## Automatic mode and checkout history

On a cache-saving branch, `disk-cache-restore: auto` compares
`MODULE.bazel.lock` with the commit preceding the current push, covering every
commit in a multi-commit push. For events without a push base, it compares the
previous commit.

This behavior may change in the future without notice!

An ordinary shallow checkout fetches the comparison commit
when necessary. If that is impossible, use `actions/checkout` with
`fetch-depth: 0`, or set `disk-cache-restore` explicitly.

The job needs `contents: read` for automatic history deepening:

```yaml
permissions:
  contents: read
```

The action uses the token input to remove the previous repository- or
disk-cache generation after a successful upload. Grant `actions: write` when
this cleanup should work; without it, the upload still succeeds and cleanup is
reported as an informational message:

```yaml
permissions:
  contents: read
  actions: write
```

## Outputs

- `cache-save-branch-evaluated`: whether this ref can save caches in the post
  action
- `bazelisk-cache-restored`, `disk-cache-restored`, and
  `repository-cache-restored`: `true` for an exact or fallback cache hit;
  `false` for a miss, disabled restore, or restore error

The following outputs are intended for the action's internal diagnostics:

- `_failed-job-cache-save-allowed`: whether every selected cache was restored
  sufficiently to allow an additive save if a later step fails
- `_checkout-history`: `skipped`, `existing`, `deepened`, or `fetched`
- `_lock-file-changed`: `true`, `false`, or `unknown`

## Logging

The action writes a compact decision summary to the workflow log. It includes
the effective restore and save decisions, branch-save eligibility, automatic
`MODULE.bazel.lock` detection, the configured cache directories, and the
Bazelisk version key.

Each restore is shown in its own expandable log group with the result and the
local cache size before and after the restore. The post action reports the
local uncompressed payload size before each save and whether the cache was
saved, skipped, or deliberately preserved. In repository-cache auto mode it
also reports the post-restore baseline and the 10% growth decision. GitHub's
cache service does not
expose the compressed archive size through the cache API, so the reported size
is the local directory size rather than the uploaded archive size.

## Cache lifecycle

Cache keys use the prefix
`setup-bazel-cache-v1-linux-<architecture>`.
Bazelisk uses the readable `.bazelversion` value in an exact cache key such as
`...-bazelisk-8.6.0` and does not restore snapshots created for another version.
Its restore and save can be disabled with `bazelisk-cache-restore` and
`bazelisk-cache-save`. The repository cache uses one rolling
timestamped generation family for the repository and runner architecture.
Bazel repository-cache entries are content-addressed, so
`MODULE.bazel.lock` and individual Bazel configs are not correctness boundaries
for this cache. Builds, fetch jobs, platforms, and configs all restore and
augment the same snapshot. Disk caches use timestamped generations and include
`disk-cache-key`. Cache API failures are reported as warnings so a transient
cache outage does not fail the build.

Successful jobs may publish new cache baselines. A failed job publishes only
when every selected cache was restored with an exact `true` result or, for
generational caches, an internal `partial` result. When the Bazelisk cache is selected,
requiring an exact Bazelisk hit prevents a failed job from publishing an old
binary under a new Bazelisk version key. The generational-cache results prove that
their snapshots extend existing caches. A restore result of `false`, `skipped`,
or `unknown` suppresses the entire failed-job save because the incomplete
snapshot would likely be worse than the existing generation. When
`repository-cache-save` is disabled, the repository restore does not participate
in this decision. Cancelled jobs never save.

On a successful job, a generational cache is also left untouched when its restore
failed with an `unknown` result. This prevents a transient cache-service or
archive error from turning an incomplete local directory into the newest cache
generation. A normal cache miss still creates a new generation.

Each disk-cache generation includes the previously restored cache plus new
entries. After a successful upload, this action removes only the previously
restored generation belonging to its own disk-cache family and Git ref. A token
with `actions: write` is required for that cleanup; without it, the upload
still succeeds and the action reports an informational message. Cache-size and
age limits are workload-specific and should be configured in the repository's
`.bazelrc` with Bazel's `--experimental_disk_cache_gc_max_size` and
`--experimental_disk_cache_gc_max_age` flags when needed.

The rolling repository snapshot may retain artifacts that are no longer
referenced. Periodically setting `repository-cache-restore: "false"` on a
cache-writing run rebuilds a compact generation from only the dependencies used
by that run. A dedicated warm-cache job should fetch every supported variant
before publishing such a replacement.

With the default `repository-cache-save: "auto"`, the first successful
cache-writing job seeds the repository cache when no snapshot can be restored.
Jobs that restore an existing snapshot publish a new generation only when the
local repository payload grows by at least 10%; after that upload, this action
removes only the previous repository generation from the same cache family and
ref when the token has `actions: write`. Use
`repository-cache-save: "true"` when a job is intended to publish an additive
generation on every successful run, or `"false"` to disable repository-cache
saving entirely.

GitHub cannot merge cache archives uploaded concurrently. If several
default-branch jobs restore the same generation, add different dependencies,
and all save, the job that finishes last publishes a snapshot without the
other jobs' additions. For deterministic coverage, use one dedicated job that:

1. runs this action with `repository-cache-save: "true"`;
2. runs `warm-bazel-repository-cache` for every supported config and variant.

Set `repository-cache-save: "false"` in other parallel jobs. They still restore
the shared repository snapshot, while their disk and Bazelisk caches retain the
normal save behavior.
