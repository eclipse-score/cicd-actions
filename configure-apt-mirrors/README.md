# Configure APT Mirrors

Configures Ubuntu's Deb822 archive sources to use an ordered APT mirror list and sets retries for failed acquisitions. APT tries earlier mirrors first and can fall back to later entries when a mirror cannot serve a requested file.

The action currently supports Ubuntu runners with `/etc/apt/sources.list.d/ubuntu.sources`, including the GitHub-hosted Ubuntu 24.04 image.

## Inputs

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `mirrors` | No | PilotFiber, then Arizona | Ordered Ubuntu archive base URLs, one per line. |
| `retries` | No | `3` | Number of times APT retries failed downloads. |

Mirror URLs must serve the configured Ubuntu suites and components. The action writes its mirror list to `/etc/apt/apt-mirrors.txt`, makes it readable to APT's unprivileged `_apt` user, and rewrites the Ubuntu source URIs to use `mirror+file:`.

## Example

Use the default mirrors:

```yaml
- uses: eclipse-score/cicd-actions/configure-apt-mirrors@<commit-sha>
```

Override them with a repository or organization variable when needed:

```yaml
- uses: eclipse-score/cicd-actions/configure-apt-mirrors@<commit-sha>
  with:
    mirrors: ${{ vars.UBUNTU_APT_MIRRORS }}
```

Run this action before `apt-get update`, `apt-get install`, or another action that invokes APT.
