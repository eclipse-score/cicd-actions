# How-to

These guides cover workflows that combine several cache settings. For a basic
job setup, start with the [README](./README.md). For the full input contract,
see the [reference](./REFERENCE.md); for cache behavior, see the
[explanation](./EXPLANATION.md).

## Build a nested module in its own job

Use this recipe if you want a separate job for a nested Bazel module, such as
`examples/integration`. Splitting your builds is optional: you can also run setup
once in the root job and build both modules there.

In the nested job, set `working-directory` on both cache setup and the Bazel run
step. Setup then uses the nested module's Bazel version and lockfile and caches
its large extracted dependencies. See
[what this improves](./EXPLANATION.md#caching-root-and-nested-modules) before
changing your job layout just for caching.

As with the basic setup, make Bazel or Bazelisk available on `PATH` before
running the action. Then use these steps:

```yaml
jobs:
  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>

      - uses: eclipse-score/cicd-actions/setup-bazel-cache@<sha>
        with:
          disk-cache-key: integration-linux
          working-directory: examples/integration

      - run: bazel test //...
        working-directory: examples/integration
```

The action input selects which module to prepare caches for; the run step's
setting selects where Bazel runs. Use one setup call per job; multiple calls in
the same job are not currently supported.

Choose `disk-cache-key` to match how you want the jobs to share build results:

- Keep a distinct key such as `integration-linux` for an independent disk cache.
  This lets parallel jobs save and clean up their own caches independently.
- Use the same key as the root job to share a disk cache. Matching build results
  can be reused, but the larger archive may take longer to transfer.

A later job can reuse a cache saved by an earlier job. Parallel jobs do not
automatically combine their new cache entries. Downloads can still be shared
when disk keys differ. Cache saving remains subject to the branch policy and
save settings; a separate job does not change those rules.

## Use the action in a build matrix

Give each matrix configuration its own disk-cache key when the configurations
produce different Bazel outputs:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        config: [x86_64-linux, aarch64-linux]
    steps:
      - uses: actions/checkout@<sha>

      - uses: eclipse-score/cicd-actions/setup-bazel-cache@<sha>
        with:
          disk-cache-key: ${{ github.job }}-${{ matrix.config }}

      - run: bazel test --config=${{ matrix.config }} //...
```

The matrix value keeps disk caches separate; the downloaded repository cache
is shared across configurations on the same runner platform and architecture.
Matrix jobs can restore that shared cache, but simultaneous saves cannot merge
their archives. If one complete repository cache should be ready before the
matrix starts, use the [warm-cache workflow](#warm-a-shared-repository-cache).

## Warm a shared repository cache

Use one producer job to fetch dependencies for the configurations that need
the same downloaded-archive cache:

```yaml
jobs:
  warm-cache:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: write # Optional; permits removal of the replaced generation.
    steps:
      - uses: actions/checkout@<sha>

      - uses: eclipse-score/cicd-actions/setup-bazel-cache@<sha>
        with:
          disk-cache-key: bazel-warm
          disk-cache-save: false
          repository-cache-save: true

      - run: bazel fetch //...
      - run: bazel fetch --config=x86_64-linux //...
      - run: bazel fetch --config=aarch64-linux //...
```

Run the producer on a branch allowed to save caches. In consumer jobs, leave
`repository-cache-restore` enabled and set `repository-cache-save: false` if
only the producer should publish repository-cache generations. Keep
matrix-specific disk-cache keys in those consumers when their outputs differ.

## Allow release branches to publish caches

By default, only the repository's default branch may save. To let release
branches publish generations too, list the default branch and the release
patterns explicitly:

```yaml
with:
  disk-cache-key: ${{ github.job }}
  cache-save-branch-patterns: |
    main
    release/**
```

The configured list replaces the default-branch-only policy, so keep `main` in
the list if it should continue saving. Pull-request refs and tags cannot save;
they can restore caches available to the workflow. Grant `actions: write` only
if the action should delete a replaced generation after upload. Do not put
secrets or private dependencies in caches readable by pull-request workflows,
including workflows from forks.
