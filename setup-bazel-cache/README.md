# Setup Bazel Cache

This Linux-only action configures Bazelisk, Bazel disk, and Bazel repository
caches for Bazel 8.6 or newer. It can also cache large extracted external
repositories and report cache reuse.

## Quick start

```yaml
steps:
  - uses: actions/checkout@<sha>

  - uses: eclipse-score/cicd-actions/setup-bazel-cache@<sha>
    with:
      # Keep this stable for the workflow job and matrix entry.
      disk-cache-key: ${{ github.workflow }}-${{ github.job }}
```

The action restores caches on every run. By default, only the repository's
default branch may publish new cache generations. To allow other branches:

```yaml
      cache-save-branch-patterns: |
        main
        release/**
```

Run `actions/checkout` before this action. If checkout metadata is missing, the
action emits a warning and continues with its normal setup; workspace-dependent
Bazel cache behavior may not work as intended.

In branch patterns, `*` stays within one path component and `**` also matches
across `/`.

Use a stable `disk-cache-key` for each job or matrix configuration. Do not
include transient values such as `github.run_id`, or every run will create a
new cache family.

## What is cached

| Cache | Purpose | Defaults |
| --- | --- | --- |
| Bazelisk | Downloaded Bazel versions | Restore and save enabled |
| Disk | Bazel action/output cache | Restore `auto`, save enabled |
| Repository | Downloaded repository archives | Restore enabled, save `auto` |
| External | Large extracted repositories | Restore and save enabled |

Cache saving is still limited to `cache-save-branch-patterns`. Repository
`auto` mode seeds a missing cache and publishes a new generation when the local
repository cache grows by at least 10%. Set the relevant save input to `false`
to disable saving.

### Extracted external repositories

Bazel's repository cache contains downloaded archives, not the extracted
directories under `bazel info output_base`/`external`. The optional external
cache can avoid both download and extraction. It uses separate GitHub cache
entries per repository and can be used with or without the repository cache.

The action resolves the output base with `bazel info output_base`. Only real
extracted directories of at least 500 MiB are cached; symlinked local
repositories are skipped. External-cache restore and save can be disabled
independently:

```yaml
      external-cache-restore: false
      external-cache-save: false
```

## Inputs users commonly change

| Input | Default | When to change it |
| --- | --- | --- |
| `disk-cache-key` | required | Separate jobs or matrix configurations |
| `cache-save-branch-patterns` | repository default branch | Allow additional branches to publish caches |
| `disk-cache-restore` | `auto` | Set `false` to start without an existing disk cache |
| `disk-cache-save` | `true` | Disable disk-cache uploads |
| `repository-cache-restore` | `true` | Start without the shared repository cache |
| `repository-cache-save` | `auto` | Use `true` for a dedicated warm-cache job, or `false` to disable uploads |
| `bazelisk-cache-restore` / `bazelisk-cache-save` | `true` / `true` | Disable Bazel version caching |
| `external-cache-restore` / `external-cache-save` | `true` / `true` | Disable extracted-repository caching |
| `token` | `${{ github.token }}` | Allow generation cleanup with a token that has `actions: write` |
| `report-cache-hits` | `true` | Disable build/action cache reporting overhead |
| `report-test-cache-hits` | `true` | Disable test-result cache reporting overhead |
| `enable-profiling` | `auto` | Use `true` for every run or `false` to disable profiling |

All boolean inputs accept only `true` or `false`. `disk-cache-restore` also
accepts `auto`; `repository-cache-save` accepts `auto`. Cache-save inputs do
not override the branch policy.

## Cache reports

The action shows a compact cache overview in the job summary and job log. It
keeps these two percentages separate because they measure different things:

| Cache | Cached / total | Hit rate | Status |
| --- | ---: | ---: | --- |
| test (test cache) | 18 / 20 | 90% | Used |
| coverage (build cache) | 3058 / 3603 | 84.87% | Used |
| Bazelisk cache | 1 / 1 | 100% | Used |
| Repository cache | 0 / 1 | 0% | Not used |
| External cache | 2 / 3 | 66.67% | Used |

`Used` means at least one result was reused or restored; `Not used` means no
result was. `⚠️ Disabled`, `Partial data`, and `Unavailable` identify disabled,
incomplete, and unknown states. A fallback to an older complete cache
generation is still counted as used. External-cache counts represent extracted
repository entries; if the manifest provides no repository entries, its result
is used instead.

### Build/action cache

`report-cache-hits` reads a separate Bazel compact execution log for every
`build`, `run`, `test`, and `coverage` invocation. It counts cacheable work that
was reused; it is not a complete measure of every Bazel action-cache lookup.

### Test-result cache

`report-test-cache-hits` reads Bazel Build Event Protocol test results for every
`test` and `coverage` invocation. It counts attempts, including retries,
shards, and repeated runs. `cachedLocally` and `executionInfo.cachedRemotely`
are counted as hits; remote execution alone is not a cache hit. A disabled
test-result cache is shown as `⚠️ Disabled`, without changing the observed
counts.

Reporting does not enable test-result caching. Bazel's normal
`--cache_test_results` setting controls whether results may be reused.

The action installs a temporary `bazel`/`bazelisk` launcher on `PATH`. Each
measured invocation receives a three-digit sequence (`000` through `999`) and
its own temporary report directory, so concurrent or repeated build commands
remain distinct. The 1000th measured invocation fails before Bazel starts;
there is no wraparound or overwrite. Only `build`, `run`, `test`, and
`coverage` consume a sequence; other Bazel commands pass through unchanged.
Malformed data keeps readable records and is marked partial; missing reports
are shown as unavailable in invocation details. Reporting errors are
non-fatal.

The launcher-provided output destinations are used for reporting. A later
user-supplied `--execution_log_compact_file`, `--build_event_json_file`, or
`--profile` option can override its destination; such custom output is not
discovered by the post step.

The launcher is used when Bazel is invoked through the normal `bazel` or
`bazelisk` command found on `PATH`. Direct absolute executable paths, aliases,
and Bazel invocations isolated inside another container are outside its scope.

### Profiling

Set `enable-profiling: true` to upload all captured build/run/test/coverage
profiles and show profile analysis in the post step. The artifact is named
`bazel-profiles-<disk-cache-key>`, so matrix jobs can identify their artifacts.
Unsafe or unusually long keys are made readable and disambiguated. Profiling
adds JSON writing and post-step processing time; no artifact is uploaded when
no measured invocation produces a profile.

## Permissions and security

Automatic disk-cache restore decisions may need commit history. Give the job
`contents: read` and use `actions/checkout` with sufficient history when
necessary:

```yaml
permissions:
  contents: read
```

The action needs `actions: write` only to delete the previous cache generation
after a successful upload. Uploads still succeed without that permission:

```yaml
permissions:
  contents: read
  actions: write
```

Default-branch caches are readable by pull-request workflows, including forks.
Do not place credentials, private dependencies, or other secrets in Bazel disk,
repository, or external caches.

## Workflow behavior to know

- Failed jobs may save only standard caches that extend a valid restored
  generation. External caches are saved only after successful jobs; cancelled
  jobs do not save.
- Concurrent jobs cannot merge GitHub cache archives. A dedicated warm-cache
  job is preferable when several jobs need to publish one shared repository
  cache.
- The post action runs only under the action's normal post-step condition. Some
  failed jobs therefore have no report.
- Cache API failures and report failures are informational and do not fail the
  build.

## Outputs

Public outputs:

- `cache-save-branch-evaluated`: whether this ref may save caches
- `bazelisk-cache-restored`, `disk-cache-restored`,
  `repository-cache-restored`, `external-cache-restored`: `true` for an exact
  or fallback restore, otherwise `false`

The action also exposes internal diagnostic outputs beginning with `_`; they
are not intended as a stable workflow interface.

## Further details

The action prints expandable restore/save diagnostics, including local
uncompressed cache sizes and automatic repository-cache decisions. Cache keys
are scoped by runner architecture and cache family; disk-cache keys are scoped
by `disk-cache-key`, while external repository keys include dependency content.
These implementation details are intentionally kept out of the normal job
summary so the useful cache results remain easy to scan.
