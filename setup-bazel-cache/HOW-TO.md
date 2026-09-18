# How-to

These guides cover workflows that combine several cache settings. For a basic
job setup, start with the [README](./README.md). For the full input contract,
see the [reference](./REFERENCE.md); for cache behavior, see the
[explanation](./EXPLANATION.md).

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
