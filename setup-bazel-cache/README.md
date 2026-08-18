# Setup Bazel Cache Experimental

> [!WARNING]
> This is a separate experimental action, not version 2 of
> [`setup-bazel-cache`](../setup-bazel-cache/README.md). Its inputs, behavior,
> cache format, and cache keys may change without a compatibility period.
> Evaluate it explicitly and pin usages to a commit SHA.

This Linux-only action configures Bazelisk, Bazel disk, and Bazel repository
caches with opinionated defaults for Bazel 8.6 or newer. Branch and
pull-request jobs restore caches; only configured cache-saving branches save
them. If no save branches are configured, the repository's default branch is
used automatically.
Its cache namespace is isolated from the stable action, so evaluating it cannot
replace or restore stable-action cache entries.

## Usage

```yaml
steps:
  - uses: actions/checkout@<sha>

  - uses: eclipse-score/cicd-actions/setup-bazel-cache-experimental@<sha>
    with:
      disk-cache-name: ${{ github.workflow }}-${{ github.job }}
      # Optional:
      cache-save-branches: |
        main
        release/*
      skip-disk-cache-restore: auto
      skip-repository-cache-restore: false
      save-repository-cache: true
```

- `disk-cache-name` separates disk caches belonging to different jobs or
  matrix configurations. It must be a stable, printable value up to 400
  characters long and must not contain commas.
- `cache-save-branches` is an optional newline-separated list of branch glob
  patterns allowed to save caches. An empty input uses the repository's GitHub
  default branch from the workflow event. `*` matches within one branch path
  component and `**` also crosses `/`, so `release/*` matches `release/1.0`.
  Pull-request refs never save caches, even when a pattern would match them.
  When multiple patterns are configured, they replace the default-branch
  fallback; include it explicitly if needed.
- `skip-disk-cache-restore` accepts `true`, `false`, or `auto`. In the default `auto`
  mode, a cache-saving branch run starts a fresh disk cache when
  `MODULE.bazel.lock` changed. Other refs restore the latest available cache.
- `skip-repository-cache-restore` accepts `true` or `false` and defaults to `false`.
- `save-repository-cache` accepts `true` or `false` and defaults to `true`.
  Set it to `false` in parallel build jobs when a dedicated warm-cache job is
  the single publisher for the shared repository snapshot. It affects saving
  only; the job can still restore the shared cache.

The action creates a temporary bazelrc with `--disk_cache` and
`--repository_cache`, then appends it to the `BAZELRC` environment variable.
Existing workspace, home, and environment-provided bazelrc files are preserved;
the temporary file is read last so the action's cache locations take
precedence.

The action supports Linux runners only.

## Cache security

GitHub makes default-branch caches readable from pull-request workflows,
including workflows triggered by forks. Do not allow Bazel's disk or repository
cache to contain secrets, credentials, private dependencies, or other artifacts
that pull-request authors must not be able to read.

## Automatic mode and checkout history

On a cache-saving branch, `skip-disk-cache-restore: auto` compares
`MODULE.bazel.lock` with the commit preceding the current push, covering every
commit in a multi-commit push. For events without a push base, it compares the
previous commit. An ordinary shallow checkout fetches the comparison commit
when necessary. If that is impossible, use `actions/checkout` with
`fetch-depth: 0`, or set `skip-disk-cache-restore` explicitly.

The job needs `contents: read` for automatic history deepening:

```yaml
permissions:
  contents: read
```

## Outputs

- `cache-save`: whether this ref can save caches in the post action
- `skip-bazelisk-cache-restore`: resolved Bazelisk-cache restore decision
- `skip-disk-cache-restore`: resolved disk-cache restore decision (`true` or `false`)
- `skip-repository-cache-restore`: resolved repository-cache restore decision
- `repository-cache-save`: whether this run will publish the shared repository
  cache (`true` only on a configured cache-saving branch when
  `save-repository-cache` is enabled)
- `failed-job-cache-save`: whether Bazelisk was restored exactly and every
  generational cache selected for saving was restored exactly or by prefix,
  allowing an additive save if a later step fails
- `bazelisk-cache-restored`, `disk-cache-restored`, and
  `repository-cache-restored`: restore result for each cache (`true` for an
  exact key, `partial` for a prefix match, `false` for a miss, `skipped`, or
  `unknown` after a cache API failure)
- `checkout-history`: `skipped`, `existing`, `deepened`, or `fetched`
- `lock-file-changed`: `true`, `false`, or `unknown`

## Cache lifecycle

Cache keys use the prefix
`setup-bazel-cache-experimental-v1-linux-<architecture>`.
Bazelisk uses an exact `.bazelversion` content hash and does not restore
snapshots created for another version. The repository cache uses one rolling
timestamped generation family for the repository and runner architecture.
Bazel repository-cache entries are content-addressed, so
`MODULE.bazel.lock` and individual Bazel configs are not correctness boundaries
for this cache. Builds, fetch jobs, platforms, and configs all restore and
augment the same snapshot. Disk caches use timestamped generations and include
`disk-cache-name`. Cache API failures are reported as warnings so a transient
cache outage does not fail the build.

Successful jobs may publish new cache baselines. A failed job publishes only
when Bazelisk was restored with an exact `true` result and every generational
cache selected for saving was restored with result `true` or `partial`. Requiring
an exact Bazelisk hit prevents a failed job from publishing an old binary under
a new `.bazelversion` content key. The generational-cache results prove that
their snapshots extend existing caches. A restore result of `false`, `skipped`,
or `unknown` suppresses the entire failed-job save because the incomplete
snapshot would likely be worse than the existing generation. When
`save-repository-cache` is disabled, the repository restore does not participate
in this decision. Cancelled jobs never save.

Each disk-cache generation includes the previously restored cache plus new
entries. Use the companion [`prune-cache`](../prune-cache/README.md) action to
remove superseded GitHub cache generations. Pruning old generations does not
limit the size of the newest Bazel disk-cache archive. Cache-size and age limits
are workload-specific and should be configured in the repository's `.bazelrc`
with Bazel's `--experimental_disk_cache_gc_max_size` and
`--experimental_disk_cache_gc_max_age` flags when needed.

The rolling repository snapshot may retain artifacts that are no longer
referenced. Periodically setting `skip-repository-cache-restore: "true"` on a
cache-writing run rebuilds a compact generation from only the dependencies used
by that run. A dedicated warm-cache job should fetch every supported variant
before publishing such a replacement.

GitHub cannot merge cache archives uploaded concurrently. If several
default-branch jobs restore the same generation, add different dependencies,
and all save, the job that finishes last publishes a snapshot without the
other jobs' additions. For deterministic coverage, use one dedicated job that:

1. runs this action with `save-repository-cache: "true"`;
2. runs `warm-bazel-repository-cache` for every supported config and variant.

Set `save-repository-cache: "false"` in other parallel jobs. They still restore
the shared repository snapshot, while their disk and Bazelisk caches retain the
normal save behavior.

## Validation model in this repository

GitHub scopes every cache to the workflow run's actual Git ref. The
`cache-save-branches` input only decides whether this action attempts a save; it
cannot move a cache into another ref's scope. A cache written on a release
branch is therefore not automatically shared with `main` or another release
branch. The repository uses that distinction to test cache writes without
giving candidate code access to the default branch's caches.

| Context | Validation | Cache scope |
| --- | --- | --- |
| Same-repository branch push that changes `setup-bazel-cache-experimental/**` | Automatic save and restore test | That feature branch |
| Fork pull request | Restore-only action tests | Pull-request/default-branch caches allowed by GitHub |
| Approved pull request in the merge queue | Automatic save and restore test | Temporary `merge_group` ref |
| `workflow_dispatch` | Optional diagnostic rerun | The explicitly selected branch |

The persistence workflow uses three jobs because GitHub runs a JavaScript
action's post step only after its job has finished:

1. A successful job seeds a baseline for all three caches.
2. A second job restores that baseline, verifies
   `failed-job-cache-save: "true"`, and adds disk and repository markers.
   Automatic runs complete successfully. A manual run can enable
   `exercise-failed-job` to fail intentionally and exercise the
   failure-sensitive post condition.
3. A final job restores the next generation and verifies the added markers.

Unit tests separately verify that misses, skipped restores, and cache API
failures produce `failed-job-cache-save: "false"`. The action exports that
decision for its failure-sensitive `post-if` condition; the pull-request action
test verifies that the exported value matches the public output.

The marker keys contain the workflow run ID and attempt, so this test cannot
pass using a cache from an earlier run.

`pull_request_target` is intentionally not used. Although it triggers reliably
for forks, it runs with the default branch's trusted workflow context.
Executing the pull request's action implementation there would expose a
privileged token and the default branch's cache scope to untrusted code.
`workflow_call`, `workflow_dispatch`, and API dispatch do not inherently solve
that trust boundary: they either inherit the caller's permissions or run in the
selected base-repository ref. The merge queue provides the required automatic,
pre-merge coverage with an isolated temporary ref and no manual approval step
beyond the normal pull-request review.
