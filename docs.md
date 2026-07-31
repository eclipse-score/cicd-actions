# Documentation Actions (`docs` and `docs-publish`)

The documentation pipeline is split into two actions:

1. `docs` builds documentation in the unprivileged pull request or push
   workflow and uploads a `github-pages` artifact.
2. `docs-publish` runs in a separate `workflow_run` workflow, retrieves that
   artifact, and publishes it to GitHub Pages with the required write
   permissions.

Keeping the build and publishing stages separate prevents untrusted pull request
code from running with repository write permissions.

## Usage

Create `.github/workflows/docs.yml` in the consuming repository:

```yaml
name: Documentation CI

on:
  pull_request:
  push:
    branches:
      - main
    tags:
      - "v*"
  release:
    types: [published]
  merge_group:
    types: [checks_requested]

jobs:
  docs:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: eclipse-score/cicd-actions/docs@docs
        with:
          retention-days: 3
          # bazel-target: "//:docs" # optional, default shown
```

Create `.github/workflows/docs-publish.yml` alongside it:

```yaml
name: Publish Documentation

on:
  workflow_run:
    workflows: ["Documentation CI"]
    types: [completed]

jobs:
  docs-deploy:
    if: github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    concurrency:
      group: cicd-pages-deploy
      cancel-in-progress: false
    permissions:
      actions: read
      contents: write
      id-token: write
      pages: write
      pull-requests: write
    steps:
      - uses: eclipse-score/cicd-actions/docs-publish@docs
        with:
          deployment-type: workflow
```

The value in `workflows` must exactly match the build workflow's `name`.
Merge-queue builds are validated but not published.
For repositories using the legacy "Deploy from a branch" Pages source, set
`deployment-type: legacy`; the action updates `gh-pages` but does not run the
GitHub Actions Pages deployment.

For a tag push or published release, the publishing action uses the triggering
run's source ref (`github.event.workflow_run.head_branch`) as the documentation
version. Do not configure both events for the same release unless publishing
the same version twice is intended.

## Build inputs

| Input | Default | Description |
| ----- | ------- | ----------- |
| `retention-days` | `1` | Number of days to retain the documentation artifact. |
| `bazel-target` | `//:docs` | Bazel target invoked with `bazel run`. |
| `tests-report-artifact` | empty | Optional artifact downloaded to `tests-report` before the docs build. |
| `gh-app-client-id` | empty | GitHub App client ID for inter-repository access. |
| `gh-app-private-key` | empty | GitHub App private key for inter-repository access. |
| `token` | empty | Token for inter-repository access. |

## Publishing behavior

Documentation from the default branch is published under its branch name, such
as `/main/`. Pull requests are published under `/pr-<number>/`; a link to that
preview is added to the pull request. Tags and releases are published under the
tag name, such as `/v1.2.3/`. The action initializes the `gh-pages` branch when
necessary and maintains its `versions.json` file.
