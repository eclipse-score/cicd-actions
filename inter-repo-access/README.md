# Inter-Repo Access

By default, GitHub Actions only gives a workflow access to its own repository. When a job needs to check out or fetch from other repositories in the organization, it requires additional credentials.

`inter-repo-access` solves this once: provide either a GitHub App or a personal access token, and the action configures git globally so every subsequent checkout and git fetch in the job uses that credential automatically — no token threading required.

It works on both GitHub.com and GitHub Enterprise Server (GHES). The action derives the target host from the current run environment (`github.server_url`).

## Auth Modes

Either a GitHub App or a direct token must be provided. If neither is given, the action falls back to `github.token`, which only has access to the current repository.

**GitHub App (recommended):** generates a short-lived installation token scoped to the organization.

```yaml
with:
  github-app-client-id: ${{ vars.INTER_REPO_APP_CLIENT_ID }}
  github-app-private-key: ${{ secrets.INTER_REPO_APP_PRIVATE_KEY }}
```

The installation owner is derived from `github.repository_owner` — the organization that triggered the workflow run. When called through a reusable workflow, this is always the caller's organization.

**Direct token:** use a personal access token or a fine-grained token with the required repository access.

```yaml
with:
  token: ${{ secrets.INTER_REPO_TOKEN }}
```

## How It Works

After the action runs, git is configured globally with URL rewrites that inject the selected token for HTTPS and SSH-style fetches on the active GitHub host.

For subsequent `actions/checkout` steps, use `persist-credentials: false`. This prevents checkout from installing its own local credential, which would shadow the global rewrite.

```yaml
- uses: actions/checkout@v4
  with:
    repository: eclipse-score/some-other-repo
    persist-credentials: false
    # No token: needed — inter-repo-access already configured git.
```

The rewrite host is derived from `github.server_url`, so the same behavior applies on GHES without extra inputs.

The action also exposes the selected token as `outputs.token` for cases where a token must be passed explicitly (for example, to a GitHub API call).

## Inputs

- `github-app-client-id`: GitHub App client ID. When set, `github-app-private-key` is also required.
- `github-app-private-key`: GitHub App private key.
- `token`: Direct token used when GitHub App credentials are not provided.

## Outputs

- `token`: The selected token, masked in logs.
- `mode`: Which auth path was used: `github-app`, `token`, or `github-token`.
- `actor`: Actor string associated with the selected credential.
- `app-slug`: GitHub App slug (GitHub App mode only).
- `installation-id`: GitHub App installation ID (GitHub App mode only).

## Example

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Configure cross-repo access
        uses: etas-contrib/score_cicd-actions/inter-repo-access@main
        with:
          github-app-client-id: ${{ vars.INTER_REPO_APP_CLIENT_ID }}
          github-app-private-key: ${{ secrets.INTER_REPO_APP_PRIVATE_KEY }}
          token: ${{ secrets.INTER_REPO_TOKEN }}

      - name: Checkout another repository
        uses: actions/checkout@v4
        with:
          repository: eclipse-score/cicd-workflows
          ref: main
          path: cicd-workflows
          persist-credentials: false
```

## Notes

- GitHub App installation tokens are scoped to the job and revoked at teardown.
- Composite actions cannot declare secret-only parameters. Pass `github-app-private-key` and `token` from caller secrets.
- On self-hosted runners, this action writes to global git config. Those global settings can remain on the runner after the job finishes unless your runner is ephemeral or you clean them up explicitly.
- Avoid logging `git config --global --list` output after this action runs — the URL rewrite contains the selected token.
