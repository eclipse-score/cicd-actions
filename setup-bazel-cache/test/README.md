
## Validation model in this repository

GitHub scopes every cache to the workflow run's actual Git ref. The
`cache-save-branch-patterns` input only decides whether this action attempts a save; it
cannot move a cache into another ref's scope. A cache written on a release
branch is therefore not automatically shared with `main` or another release
branch. The repository uses that distinction to test cache writes without
giving candidate code access to the default branch's caches.

| Context | Validation | Cache scope |
| --- | --- | --- |
| Same-repository branch push that changes `setup-bazel-cache/**` | Automatic save and restore test | That feature branch |
| Fork pull request | Restore-only action tests | Pull-request/default-branch caches allowed by GitHub |
| Approved pull request in the merge queue | Automatic save and restore test | Temporary `merge_group` ref |
| `workflow_dispatch` | Optional diagnostic rerun | The explicitly selected branch |

The persistence workflow uses three jobs because GitHub runs a JavaScript
action's post step only after its job has finished:

1. A successful job seeds a baseline for all three caches.
2. A second job restores that baseline, verifies
   `_failed-job-cache-save-allowed: "true"`, and adds disk and repository markers.
   Automatic runs complete successfully. A manual run can enable
   `exercise-failed-job` to fail intentionally and exercise the
   failure-sensitive post condition.
3. A final job restores the next generation and verifies the added markers.

Unit tests separately verify that misses, skipped restores, and cache API
failures produce `_failed-job-cache-save-allowed: "false"`. The action exports that
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
