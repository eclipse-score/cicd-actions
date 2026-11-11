# score_cicd-actions

Reusable GitHub Actions for S-CORE CI/CD automation. For reusable workflows, see the [score_cicd-workflows](https://github.com/eclipse-score/cicd-workflows) repository.

## Actions

- [`inter-repo-access`](./inter-repo-access/README.md): resolve one auth mode and configure git for consistent cross-repository access.
- [`setup-qnx-sdp`](./setup-qnx-sdp/README.md): setup QNX SDP environment for CI/CD workflows.
- [`setup-bazel-cache`](./setup-bazel-cache/README.md): configure Bazel caching with opinionated defaults.
- [`unblock-user-namespace-for-linux-sandbox`](./unblock-user-namespace-for-linux-sandbox/README.md): allow Bazel's `linux-sandbox` to create user namespaces on Ubuntu runners.
- [`prune-cache`](./prune-cache/README.md): keep only the newest GitHub Actions cache generation per cache family and Git ref, deleting older ones.
- [`warm-bazel-repository-cache`](./warm-bazel-repository-cache/README.md): validate and warm Bazel repository cache for configured variants (supports validation-only dry runs).

## Self Testing

Most actions have a self-test workflow in the `.github/workflows` directory (`test-*.yml`) that exercises the action in a real runner environment. These workflows are reusable (`workflow_call`) and are executed from the [`PR workflow`](./.github/workflows/_local_on_pr.yml).

## Dependency updates

Dependabot groups npm security updates across `setup-bazel-cache` and
`setup-qnx-sdp`. Scheduled minor and patch updates form a separate group;
scheduled major version updates remain separate for review.

For each Dependabot PR that changes an action manifest or lockfile,
[`dependabot-build.yml`](./.github/workflows/dependabot-build.yml) builds both
JavaScript actions with the Node and npm versions used by pre-commit. It runs
lint and available unit tests before uploading changed distribution bundles.
The build has read-only repository access and receives no bot credentials.

[`dependabot-commit.yml`](./.github/workflows/dependabot-commit.yml) runs after a
successful build, using publisher code from the default branch on a fresh
runner. It accepts only the five generated `dst/**/index.js` paths from the
artifact and checks that the same-repository Dependabot PR is still open at the
built commit. An atomic expected-head check prevents races with newer pushes.
Unchanged bundles produce no commit.

The publisher uses the existing organization secret `SCORE_BOT_CLASSIC_PAT`
so its follow-up commit triggers the normal PR checks automatically. Forks need
to provide their own bot PAT under that name to enable publishing. Both workflows
must be on the default branch before publishing works. Existing Dependabot PRs
need to be rebased onto that version so their branches include the build helper.

## Why are the actions in a separate repository?

While it's possible to call actions in the same repository, as witnessed by the self-tests, it is not (easily) possible to do that from a reusable workflow. Since reusable workflows are a key part of our strategy for sharing CI/CD logic, we place the actions in a separate repository to ensure they can be used from any workflow in any repository.

## Do they work outside of S-CORE?

Yes! However, testing is focused on the eclipse-score use case. Forks and private copies of S-CORE should work fine. GitHub Server and GitHub Data Residency are untested, so compatibility is not guaranteed — we welcome fixes but cannot offer support for those environments.
