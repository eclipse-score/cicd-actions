# Explanation

This page explains how the action's caches and reports behave. Use the
[how-to guide](./HOW-TO.md) for workflow recipes and the
[reference](./REFERENCE.md) for input and output definitions.

## What each cache stores

The action configures separate caches because Bazel stores different kinds of
reusable data in different places:

| Cache | Contents | Benefit |
| --- | --- | --- |
| Bazelisk | Downloaded Bazel versions | Avoids downloading the selected Bazel version again |
| Disk | Reusable Bazel action results and outputs | Avoids re-running cacheable actions when their keys match |
| Repository | Downloaded repository archives | Avoids downloading external sources again |
| External | Large extracted directories below Bazel's `output_base/external` | Can avoid repository extraction as well as downloads |

The action configures `--disk_cache` and `--repository_cache`; it does not
configure a remote cache. Bazel's normal configuration and the caller's
`.bazelrc` continue to control other behavior, including repository download
retries.

## Cache restore and save

GitHub Actions cache entries are immutable archives. The action restores them
before workflow Bazel commands run, then packages updated cache directories in
its post step. A cache-save branch policy controls which refs may publish new
generations; configuring patterns replaces the default-branch-only list, so
include the default branch if it should remain allowed. The policy does not
restrict reads: restore inputs and GitHub's cache scope still apply, including
to pull-request workflows reading caches from the default branch.

### Generations

Each generation gets an exact cache key with a unique timestamp. Restore uses a
stable `generation-` prefix to find the newest matching generation without
knowing its timestamp. A cache miss can seed a generation. An unknown or failed
restore does not replace an existing generation. After a successful upload,
the action can delete the generation it restored if its token has
`actions: write` permission. This removes a whole GitHub cache entry.

After a failed workflow step, standard caches can be saved only when the
action restored a valid generation that the new data can extend. Extracted
external caches are saved only after a successful job, and cancelled jobs do
not save caches. If setup did not complete, the post step skips cache saving.

Cache keys have different scopes:

- runner platform and architecture separate every cache family;
- `disk-cache-key` separates disk caches for jobs or matrix configurations;
- the downloaded repository cache is shared across lockfiles and build
  configurations on the same platform and architecture, but automatic restore
  starts a fresh generation after a lockfile change when this run may save;
- `.bazelversion` selects the Bazelisk download cache;
- external repository identity uses the repository name, `.bazelversion`,
  `MODULE.bazel.lock` (or `MODULE.bazel` when no lock file exists), and legacy
  WORKSPACE files when present.

Including legacy WORKSPACE files prevents workspaces with different legacy
repository definitions from sharing extracted repositories.

### Automatic restore and save decisions

With `disk-cache-restore: auto`, the action checks whether
`MODULE.bazel.lock` changed relative to the available comparison commit when
this run is allowed to save the disk cache. If it changed, the action skips the
existing disk-cache restore to avoid mixing outputs across dependency
resolutions. If the disk cache will not be saved, that history-dependent check
is not needed and the configured restore is allowed. Checkout must therefore
run before the action when this automatic policy is desired.

With `repository-cache-restore: auto`, the same comparison controls whether
the shared downloaded-archive cache is restored. If the lockfile changed and
this run may save the repository cache, the action skips the old archive. A
successful build then seeds a generation from the downloads needed by the new
lockfile, even if it does not meet the configured growth threshold. If this run
cannot save, the action restores the existing cache. Set the input to `true`
to always attempt restore or `false` to skip it.

With `repository-cache-save: auto`, the action saves a new generation when the
repository cache is empty at the start of the job, or when the local cache
reaches the `repository-cache-growth-threshold` (10% by default). Set that
threshold to `0` to save after any positive growth. A lockfile-triggered reset
also seeds a new generation. Setting `repository-cache-save` to `true` saves
every eligible non-empty run; `false` disables these uploads.

Concurrent jobs cannot merge cache archives. If several jobs need to populate
one shared repository cache, use a single warm-cache job.

### Extracted external repositories

Bazel's repository cache stores downloaded archives, not the extracted trees
under `output_base/external`. The external cache restores an action-owned
manifest and then restores each listed repository separately. It can avoid
both downloading and extracting large repositories.

Only real extracted directories of at least 500 MiB are eligible for saving;
symlinked local repositories are skipped. External cache entries are keyed by
repository identity and dependency-file content. The manifest is generational,
while per-repository entries are immutable. Changed dependency definitions
create new entries; the action does not delete old per-repository entries.
External caches are saved only after a successful job.

### Cache cleanup

After a successful upload, the action tries to delete the cache generation it
restored. If automatic repository-cache restore was skipped after a lockfile
change, it lists generations in that cache family on the current ref instead.
After the replacement upload succeeds, it deletes those old generations. This
uses the GitHub cache API and does not download the old archives. Listing and
deletion require Actions read and write permission, respectively. In a workflow,
`actions: write` is sufficient for both. If the API cannot list or delete the
generations, GitHub's retention and eviction policies still apply to the old
entries.

The action does not delete old per-repository external-cache entries when
dependency definitions change. Bazel's disk-cache and repository-contents GC
flags manage different cache locations; they do not prune downloaded archives
stored by `--repository_cache`. See the
[Bazel command-line reference](https://bazel.build/versions/8.6.0/reference/command-line-reference).

## Reports

The action writes a cache overview to the job log and, by default, to the
GitHub Actions step summary. It reports cache restores separately from results
grouped under each measured Bazel invocation. Build/action cache and test-result
cache percentages describe different kinds of work.

### Build/action cache

For each `build`, `run`, `test`, or `coverage` invocation, the action reads a
Bazel compact execution log. It counts cacheable spawns marked as cache hits
against all observed cacheable spawns. This is not a count of every Bazel cache
lookup and is not an estimate of time saved. Malformed logs retain readable
records where possible and are marked partial; a missing log is unavailable,
not a zero-hit result.

### Test-result cache

For each `test` or `coverage` invocation, the action reads Bazel Build Event
Protocol test results. It counts attempts separately, including retries,
shards, and repeated runs. A result counts as cached when Bazel reports
`cachedLocally` or `cachedRemotely`. Remote execution by itself is not a test
cache hit.

Reporting observes Bazel's effective `--cache_test_results` setting; it does
not enable test-result caching. A command-line or workspace setting can
therefore disable reuse while the action still reports the observed results.

Invocation elapsed time is the measured wall-clock time between the recorded
start and finish. It is not an estimate of time saved by caching. The report
uses statuses such as `Used`, `Not used`, `Disabled`, `Partial data`, and
`Unavailable` to distinguish hits from disabled or incomplete reports.

### Profiles and invocation limits

The action installs temporary `bazel` and `bazelisk` launchers on `PATH` to
record supported invocations. Only `build`, `run`, `test`, and `coverage` are
measured. Calls through an absolute executable path, another container, or a
wrapper that bypasses the action's `PATH` launcher are not measured.

Each measured invocation gets its own report directory and sequence from `000`
through `999`. The 1000th measured invocation stops before Bazel starts, so an
earlier report cannot be overwritten. Other Bazel commands pass through
without using a sequence number.

With profiling enabled, Bazel writes a profile for each measured invocation.
The post step analyzes profiles and uploads them as the
`bazel-profiles-<disk-cache-key>` artifact. No artifact is uploaded when no
measured invocation produced a profile. If a command overrides the
action-provided `--execution_log_compact_file`, `--build_event_json_file`, or
`--profile` destination, the post step does not discover that custom file.

Reporting and cache API errors are warnings. They do not change the Bazel
build or test exit code. Setup errors, including invalid inputs, are warnings
and stop the affected setup phase. If setup did not complete, the post step
skips cache saving.

## Investigate unexpected behavior

1. Expand the action's **Bazel cache decision** log group to see restore/save
   choices, the generated rc file, cache directories, and branch policy.
2. For extracted repositories, check the `output_base` from `bazel info
   output_base`.
3. Read build/action and test-result cache reports separately; their rates
   count different things.
4. If no invocation appears, check that Bazel runs through `bazel` or
   `bazelisk` on `PATH` and that the command is `build`, `run`, `test`, or
   `coverage`.
