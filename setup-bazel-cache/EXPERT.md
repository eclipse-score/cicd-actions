# Setup Bazel Cache: Bazel expert guide

This guide describes how `setup-bazel-cache` interacts with Bazel. It is aimed
at engineers who tune Bazel builds, investigate cache behavior, or need to
interpret the action's reports. For normal workflow setup and input defaults,
see the [user-facing README](./README.md).

The action supports Linux runners and Bazel 8.6 or newer.

## The effective Bazel configuration

The action restores caches before the following workflow steps run and writes
an action-owned Bazel rc file. The important Bazel settings are equivalent to:

```text
build  --disk_cache=$HOME/.cache/bazel-disk
common --repository_cache=$HOME/.cache/bazel-repo
```

The actual paths use the runner's home and temporary directories. The generated
rc file is imported through the user's `.bazelrc` for Bazel 8 compatibility; the
action also exposes the generated file through `BAZELRC` together with any
existing `BAZELRC` value. The action does not configure a remote cache.

These settings have different Bazel responsibilities:

| Bazel setting | Contents | Effect of restoring it |
| --- | --- | --- |
| `--disk_cache` | Locally reusable action results and outputs | Avoids re-executing cacheable actions when the action key matches |
| `--repository_cache` | Downloaded repository archives | Avoids downloading repository archives again |
| Bazelisk cache | Downloaded Bazel versions; not a Bazel flag | Avoids downloading the selected Bazel version |
| External cache | Extracted directories below `output_base/external` | Can avoid repository extraction as well as downloading |

The rc file is job configuration. Report destinations are not placed in it,
because every Bazel process needs a separate destination and the temporary
launcher allocates one immediately before that process starts.

## Flags added to Bazel commands

When reporting or profiling is enabled, the action puts its flags after the
Bazel command and before the caller's remaining arguments. This preserves the
usual Bazel precedence rule: a later caller-supplied option can override an
action-generated destination.

| Input | Bazel commands | Effective flags |
| --- | --- | --- |
| `report-cache-hits: true` | `build`, `run`, `test`, `coverage` | `--execution_log_compact_file=<invocation>/execution.log.zst` |
| `report-test-cache-hits: true` | `test`, `coverage` | `--build_event_json_file=<invocation>/test.bep.json` and `--nobuild_event_json_file_path_conversion` |
| `enable-profiling: true` (or `auto` with runner debug logging) | `build`, `run`, `test`, `coverage` | `--profile=<invocation>/profile.gz` |

The action never adds `--cache_test_results`. Test-result reporting observes
Bazel's effective setting, including settings from the workspace rc files or a
command-line option. For example, this command deliberately disables reuse
while still producing a report:

```bash
bazel test --cache_test_results=no //path/to:tests
```

If a command supplies its own `--execution_log_compact_file`,
`--build_event_json_file`, or `--profile` after the injected flags, Bazel uses
the caller's path. The post step only discovers the action-owned path, so the
custom file is not included in the action's report or profile upload.

### Which invocations are instrumented

The temporary `bazel` and `bazelisk` shims on `PATH` identify the first
non-option argument as the Bazel command. Only `build`, `run`, `test`, and
`coverage` receive an invocation record and report flags. Commands such as
`info`, `query`, and `shutdown` pass through without consuming an invocation
sequence.

The following forms are therefore outside the reporting path:

- invoking an absolute Bazel executable path instead of `bazel` or `bazelisk`;
- an alias or wrapper that does not reach the action's `PATH` shim;
- a Bazel process started inside another container;
- placing `--` before the Bazel command, which prevents command detection.

The launcher forwards Bazel's exit status and signals. Instrumentation does not
change whether the build or test succeeds.

## Reports read by the post step

Each measured invocation gets a directory below:

```text
$RUNNER_TEMP/setup-bazel-cache-invocations/<sequence>-<command>/
```

`<sequence>` is a three-digit number such as `000`; the directory also contains
`metadata.json`. The action reads the following files when they were enabled
and produced by Bazel:

| File | Bazel format | What the action counts or displays |
| --- | --- | --- |
| `execution.log.zst` | zstd-compressed compact execution log containing length-delimited `ExecLogEntry` records | Cacheable spawns with `cache_hit` set, grouped by Bazel runner; non-cacheable work is ignored |
| `test.bep.json` | newline-delimited Build Event Protocol JSON | Test attempts and whether each was locally or remotely cached |
| `profile.gz` | gzip-compressed Bazel JSON trace profile | Total duration, critical path, phase durations, and action-mnemonic statistics |
| `metadata.json` | action-owned JSON metadata | Command, recognized targets, start/finish timestamps, exit status, and which reports were enabled |

### Execution-log metric

The build-cache percentage is:

```text
cacheable spawns with cache_hit / all observed cacheable spawns
```

It is a measure of reusable action work, not a count of every cache lookup and
not an estimate of time saved. The report also shows the runners that supplied
cached results or executed work, such as a disk cache, shared cache, or local
strategy.

Malformed or truncated compact logs retain readable records where possible and
are marked partial. A missing file is unavailable rather than a zero-hit build.

### Test-result metric

The test-cache report reads `TestResult` events from the BEP file. Its identity
includes the test label, configuration, run, shard, and attempt, so retries,
shards, and repeated runs are counted separately. The following are cache hits:

- `cachedLocally: true`;
- `executionInfo.cachedRemotely: true` when the local flag is not already true.

Remote execution by itself is not a test-cache hit. The report also reads the
canonical Bazel command line from the BEP stream to show whether
`cache_test_results` was `yes`, `no`, `auto`, or unknown. Invalid records do not
erase valid records; the report is marked partial when input was incomplete.

### Profiles

Profiles are analyzed in the post step and uploaded as an artifact named from
`disk-cache-key`, for example `bazel-profiles-linux-debug`. The profile is
captured independently for each measured command. Profiling adds Bazel JSON
writing and post-step work; no artifact is uploaded when no measured invocation
produces a profile.

## Cache interaction and generations

The action bridges two different cache models:

1. Bazel consumes and mutates local directories during the job.
2. GitHub Actions caches immutable archives and only makes them available by
   cache key or restore prefix.
3. The action's post step packages the directories after the workflow's Bazel
   commands have finished.

The cache families are intentionally separate:

- **Disk cache:** generational and scoped by runner architecture and the stable
  `disk-cache-key`.
- **Repository cache:** generational and shared independently of the disk-cache
  key; `auto` saves when no generation was restored or when the local cache grew
  by at least 10%.
- **Bazelisk cache:** keyed by the selected `.bazelversion` value.
- **External repositories:** per-repository caches below Bazel's
  `output_base/external`, plus a generational manifest listing the repositories.

Generational families use a timestamped key for each upload and restore the
newest matching generation through ordered restore prefixes. An exact restore
and a fallback restore are exposed as successful restores. A cache miss can
seed a new generation, but an unknown or failed restore does not replace the
existing generation. After a successful upload, the action may delete the
previous generation when the token has `actions: write` permission.

The stable key dimensions prevent unrelated Bazel configurations from sharing
one archive:

- runner platform and architecture are part of every cache family;
- `disk-cache-key` separates jobs or matrix configurations;
- `.bazelversion` selects the Bazelisk download cache;
- external repository identity includes `.bazelversion`, `MODULE.bazel.lock`
  (or `MODULE.bazel` when no lock file exists), and legacy WORKSPACE files.

### Automatic disk-cache restore

With `disk-cache-restore: auto`, the action checks whether
`MODULE.bazel.lock` changed relative to the available comparison commit when
the disk cache will also be saved. If it changed, the existing disk cache is
not restored to avoid mixing action outputs across dependency resolutions. If
the disk cache is not going to be saved, this history-dependent decision is not
needed and the configured restore is allowed.

This is why checkout must precede the action when automatic disk-cache policy
is desired: the action may need repository history to establish the comparison
base.

### External repositories

Bazel's repository cache contains downloaded archives. The extracted trees used
by the running workspace live under `bazel info output_base`/`external`, so
restoring repository archives alone can still leave Bazel with a large
extraction cost.

When external caching is enabled, the action resolves `bazel info output_base`,
restores an action-owned manifest, and then restores each listed repository
separately. On save, only real extracted directories of at least 500 MiB are
eligible; symlinked local repositories are skipped. The manifest is refreshed
after eligible repositories have been saved.

External caches are saved only after a successful job. This prevents a failed
build from publishing an incomplete extracted repository tree.

## Why the integration has multiple layers

Using only `--disk_cache` would not solve the complete CI problem:

- Bazel's disk and repository caches are mutable directories, while GitHub cache
  entries are immutable archives.
- The cache contents are produced by later workflow steps, so saving must happen
  in the action's post step.
- A single cache-hit number cannot represent action-result reuse and test-result
  reuse: they are reported by different Bazel interfaces and count different
  units.
- Repository archives do not contain extracted external trees, which requires a
  separate output-base-aware cache.
- Parallel jobs cannot merge GitHub cache archives. Generation prefixes and
  branch/ref policy keep one job from silently replacing another job's snapshot.

The resulting lifecycle is:

```text
setup action main
  -> restore archives, write Bazel rc, install PATH shims
workflow Bazel steps
  -> consume caches and write per-invocation Bazel reports
setup action post
  -> analyze reports, save populated caches, upload profiles
```

Cache API and report-processing failures are warnings. They must not turn a
usable Bazel build into a failed build, and the post step preserves an existing
generation when a restore was not trustworthy. Launcher setup errors and the
explicit 1000-invocation limit are separate execution safeguards.

## Practical diagnostics

For a cache or report investigation:

1. Expand the action's **Bazel cache decision** group and verify the effective
   restore/save matrix, generated rc path, cache directories, and branch policy.
2. Use `bazel info output_base` to identify the output base that contains the
   extracted external repositories.
3. Check the per-invocation summary and the expandable build-cache and test-cache
   details separately. A build-cache hit rate and a test-cache hit rate are not
   interchangeable.
4. Keep the action-owned report destinations unless there is a specific reason
   to override them. Custom destinations are valid Bazel behavior but are not
   discovered by the post step.
5. If the action reports no measured invocation, verify that the workflow calls
   `bazel` or `bazelisk` through `PATH` and that the command is one of
   `build`, `run`, `test`, or `coverage`.

The launcher supports sequences `000` through `999`. The 1000th measured
invocation fails before Bazel starts instead of overwriting an earlier report.
