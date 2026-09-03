# Setup Bazel Cache

This Linux-only action configures Bazelisk, Bazel disk, and Bazel repository
caches with opinionated defaults for Bazel 8.6 or newer. It can also cache
large extracted external repositories. Branch and
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
  values such as `${{ github.run_id }}`. Dots are encoded as `__` in the cache
  key, single underscores are preserved, and `__` (as well as ambiguous
  dot/underscore adjacency) is reserved and rejected.
- `cache-save-branch-patterns` is an optional newline-separated list of branch
  glob patterns allowed to save caches. An empty input uses the repository's GitHub
  default branch.
  Globbing: `*` matches within one branch path component and `**` also crosses `/`,
  so `release/*` matches `release/1.0` and `release/**` matches `release/1/0` and `release/2.0`.

### Extracted external-repository cache

Bazel's repository cache stores downloaded archive contents. It does not store
the extracted repositories that Bazel materializes under
`$(bazel info output_base)/external`. The external cache stores those extracted
repositories as separate GitHub Actions cache entries, so a hit can avoid both
the download and extraction steps. This is action-level caching; Bazel itself
does not provide an `external-cache` flag.

```yaml
- uses: eclipse-score/cicd-actions/setup-bazel-cache@<sha>
  with:
    disk-cache-key: ${{ github.job }}
    external-cache-restore: true
    external-cache-save: true
```

The action discovers the output base with `bazel info output_base` before
restoring external repositories. It caches real extracted directories of at
least 500 MiB and skips symlinked local repositories. The cache key is independent
of `disk-cache-key`; it is based on the repository name, runner architecture,
the Bazel version, `MODULE.bazel.lock`, and any existing legacy `WORKSPACE*`
files. If no lockfile exists, `MODULE.bazel` is used as a fallback. Dots in
repository names are encoded as `__`; the reserved `__` sequence and ambiguous
dot/underscore adjacency are rejected so names cannot become ambiguous
cache-key components. The manifest is cached
separately so the action knows which repository names to restore before the
build.

External caching can be used without the repository cache. In that mode, an
external-cache hit avoids the download and extraction; a miss falls back to
Bazel's normal network fetch. Enabling both caches provides a repository-cache
fallback for external-cache misses but stores more data.

### Optional Bazel profiling

Profiling defaults to `auto`, which enables it automatically for GitHub Actions
debug runs. Set `enable-profiling: true` to enable it for every run:

```yaml
- uses: eclipse-score/cicd-actions/setup-bazel-cache@<sha>
  with:
    disk-cache-key: ${{ github.workflow }}-${{ github.job }}
    enable-profiling: true
```

The action uploads the raw profiles as the `bazel-profiles` artifact in its post
step. It does not analyze the profiles in the workflow log. There is one fixed
profile for `build` and one for `test`; if a command is invoked more than once,
the later invocation overwrites the earlier profile. If neither command runs,
no profiling artifact is created. Set `enable-profiling: false` to disable
profiling, including for debug runs.

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
  `external-cache-restore` and `external-cache-save` accept `true` or `false`
  and default to `true`. External saves are also limited to configured
  cache-saving branches.

## Cache security

GitHub makes default-branch caches readable from pull-request workflows,
including workflows triggered by forks. Do not allow Bazel's disk, repository,
or external cache to contain secrets, credentials, private dependencies, or
other artifacts that pull-request authors must not be able to read. Extracted
repositories may contain generated credentials or downloaded private content,
depending on the repository rule.

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
- `bazelisk-cache-restored`, `disk-cache-restored`,
  `repository-cache-restored`, and `external-cache-restored`: `true` for an
  exact or fallback cache hit;
  `false` for a miss, disabled restore, or restore error

The following outputs are intended for the action's internal diagnostics:

- `_failed-job-cache-save-allowed`: whether the selected standard caches were
  restored sufficiently to allow an additive save if a later step fails. It is
  false when external cache saving is enabled.
- `_checkout-history`: `skipped`, `existing`, `deepened`, or `fetched`
- `_lock-file-changed`: `true`, `false`, or `unknown`

## Logging

The action writes a compact decision summary to the workflow log. It includes
the effective restore and save decisions, branch-save eligibility, automatic
`MODULE.bazel.lock` detection, the configured cache directories, and the
Bazelisk version key.

Each restore is shown in its own expandable log group with the result and the
local cache size before and after the restore. Once all selected restores
complete, a restore summary table reports the result and before/after size for
every cache in one place, so a hit, a partial (older-generation) restore, or a
miss is visible without expanding any group. The post action reports the local
uncompressed payload size before each save and whether the cache was saved,
skipped, or deliberately preserved, then ends with an equivalent save summary
table. In repository-cache auto mode it also reports the post-restore baseline
and the 10% growth decision. GitHub's cache service does not expose the
compressed archive size through the cache API, so the reported size is the
local directory size rather than the uploaded archive size.

## Cache lifecycle

Cache keys use readable dot-separated components. For example, a disk cache
with `disk-cache-key: build.qnx_x86_64` has the generation key
`setup-bazel-cache.disk.linux-x64.build__qnx_x86_64.<timestamp>`.
Bazelisk uses the readable `.bazelversion` value as the final exact component
in a key such as `setup-bazel-cache.bazelisk.linux-x64.8.6.0` and does not
restore snapshots created for another version.
Its restore and save can be disabled with `bazelisk-cache-restore` and
`bazelisk-cache-save`. The repository cache uses one rolling
timestamped generation family for the repository and runner architecture, such
as `setup-bazel-cache.repository.linux-x64.<timestamp>`.
Bazel repository-cache entries are content-addressed, so
`MODULE.bazel.lock` and individual Bazel configs are not correctness boundaries
for this cache. Builds, fetch jobs, platforms, and configs all restore and
augment the same snapshot. Disk caches use timestamped generations and include
`disk-cache-key`. External repository caches use separate immutable keys based
on the repository name and dependency-content hash, such as
`setup-bazel-cache.external.linux-x64.rules__cc.<hash>`; dots in repository
names are encoded as `__` so they cannot create ambiguous structural
components; ambiguous dot/underscore adjacency is rejected. Unchanged
extracted repositories are not uploaded again. The
manifest remains a small rolling generation such as
`setup-bazel-cache.external-manifest.linux-x64.<timestamp>` that records which
repositories to restore. Cache API failures are reported as warnings so a
transient cache outage does not fail the build.

External repository caches are discovered after the workflow's Bazel commands
finish. The manifest records only repositories that meet the size threshold;
repositories that miss the external cache are still fetched normally by Bazel
and become eligible for the next successful save.

Successful jobs may publish new cache baselines. The action can add to existing
standard caches after a failed job, but only when every selected standard cache
was restored with an exact `true` result or, for generational caches, an internal
`partial` result. When external cache saving is enabled, the failed-job path is
disabled entirely, so extracted external repositories are published only after
a successful job. Cancelled jobs never save.

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
