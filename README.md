# score_cicd-actions

Reusable GitHub Actions for S-CORE CI/CD automation. For reusable workflows, see the [score_cicd-workflows](https://github.com/eclipse-score/cicd-workflows) repository.

## Actions

- [`inter-repo-access`](./inter-repo-access/README.md): resolve one auth mode and configure git for consistent cross-repository access.
- [`setup-qnx-sdp`](./setup-qnx-sdp/README.md): setup QNX SDP environment for CI/CD workflows.

## Self Testing

This repo includes self-test workflows for (some of) the provided actions in the `.github/workflows` directory:

- [`test-inter-repo-access.yml`](./.github/workflows/test-inter-repo-access.yml) tests the [`inter-repo-access`](./inter-repo-access/README.md) action by configuring it with a token and then verifying that the token is correctly injected into git for a subsequent checkout of another repository.

- [`test-setup-qnx-sdp.yml`](./.github/workflows/test-setup-qnx-sdp.yml) tests the [`setup-qnx-sdp`](./setup-qnx-sdp/README.md) action by configuring it with a fake license and then verifying that the license file and environment variables are correctly set up.

These workflows are reusable (`workflow_call`) and are executed from the [`PR workflow`](./.github/workflows/_local_on_pr.yml)

## Why are the actions in a separate repository?

While it's possible to call actions in the same repository, as witnessed by the self-tests, it is not (easily) possible to do that from a reusable workflow. Since reusable workflows are a key part of our strategy for sharing CI/CD logic, we place the actions in a separate repository to ensure they can be used from any workflow in any repository.

## Do they work outside of S-CORE?

Yes! However, testing is focused on the eclipse-score use case. Forks and private copies of S-CORE should work fine. GitHub Server and GitHub Data Residency are untested, so compatibility is not guaranteed — we welcome fixes but cannot offer support for those environments.
