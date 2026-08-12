# Setup Bazel Cache

This Linux-only action configures Bazelisk, Bazel disk, and Bazel repository
caches with opinionated defaults. Branch and pull-request jobs restore caches;
only the configured main branch saves them.

## Usage

```yaml
steps:
  - uses: actions/checkout@<sha>

  - uses: eclipse-score/cicd-actions/setup-bazel-cache@<sha>
    with:
      unique-cache-name: ${{ github.workflow }}-${{ github.job }}
      # Optional:
      main-branch: main
      skip-disk-cache-restore: auto
      skip-repository-cache-restore: false
```

- `unique-cache-name` separates disk caches belonging to different jobs or
  matrix configurations.
- `main-branch` selects the only branch allowed to save caches.
- `skip-disk-cache-restore` accepts `true`, `false`, or `auto`. In the default `auto`
  mode, a main-branch run starts a fresh disk cache when `MODULE.bazel.lock`
  changed. Other refs restore the latest main-branch cache.
- `skip-repository-cache-restore` accepts `true` or `false` and defaults to `false`.

The action creates `~/.bazelrc` with `--disk_cache` and `--repository_cache`.
It deliberately fails before inspecting Git history or restoring caches if
that file already exists, because merging independently owned user-level Bazel
configuration is ambiguous.

The action supports Linux runners only.

## Automatic mode and checkout history

On the main branch, `skip-disk-cache-restore: auto` compares `MODULE.bazel.lock` with
the previous commit. An ordinary shallow checkout is deepened by one commit
when necessary. If that is impossible, use `actions/checkout` with
`fetch-depth: 2`, or set `skip-disk-cache-restore` explicitly.

The job needs `contents: read` for automatic history deepening:

```yaml
permissions:
  contents: read
```

## Outputs

- `skip-disk-cache-restore`: resolved disk-cache restore decision (`true` or `false`)
- `skip-repository-cache-restore`: resolved repository-cache restore decision
- `checkout-history`: `skipped`, `existing`, or `deepened`
- `lock-file-changed`: `true`, `false`, or `unknown`

## Deprecated input

`skip-cache-restore` remains available for migration and emits a warning. It
accepts `true`, `false`, or `auto` and applies the resolved decision globally
to Bazelisk, disk, and repository caches. Do not combine it with either new
skip input. The input will be removed in the next breaking release; there is
no corresponding deprecated output.

## Cache lifecycle

Cache keys retain the internal `setup-bazel-1-linux-<architecture>` prefix from
the vendored setup action.
Bazelisk and repository caches use content hashes. Disk caches use timestamped
generations and include `unique-cache-name`. Cache API failures are reported as
warnings so a transient cache outage does not fail the build.

The internal implementation is a narrowly patched vendored copy of
`bazel-contrib/setup-bazel`; see its `NOTICE.md` and retained MIT license.
