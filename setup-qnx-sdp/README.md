# Setup QNX SDP

## Description

This JavaScript-based GitHub Action prepares a runner so Bazel builds and tests can use the QNX Software Development Platform (SDP).

It performs the following:

- Masks sensitive inputs in workflow logs.
- Validates and prepares an optional QNX credential helper script.
- Decodes and writes a QNX client license file.
- Optionally configures QNX license server settings for the current job and Bazel.
- Configures access to qnx.com via `.netrc`.
- Automatically removes the QNX license file and the `.netrc` entry when the job finishes (post-action).

## How it works

When invoked, the action runs these steps in order:

1. Mask secrets in logs (`qnx-license`, `qnx-user`, `qnx-password`).
2. Prepare qnx.com credential helper (only when `qnx-credential-helper` input is not empty).
3. Prepare QNX license file.
4. Configure qnx license server (only when `qnx-license-server` input is not empty):
   - If no `.bazelrc` exists in the repository root, the step logs a warning and continues.
   - If `.bazelrc` exists but does not contain `try-import %workspace%/user.bazelrc`, the step logs a warning and continues.
   - Exports license-related environment variables to `GITHUB_ENV`.
   - Appends Bazel flags to `user.bazelrc` for build and test environments.
5. Configure access to qnx.com via `.netrc`.

After the job completes (always, even on failure or cancellation), the post-action automatically removes the QNX license directory and the `.netrc` entry created in steps 3 and 5.

## Inputs

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `qnx-license` | Yes | - | Base64 encoded QNX client license file content. |
| `qnx-license-dir` | Yes | `/opt/qnx/license` | Directory where the decoded license file is written. Supports absolute paths and `~/...`. |
| `qnx-license-server` | No | - | QNX license server address, for example `6287@license-server-hostname`. When set, license server settings are configured for the job and Bazel. |
| `qnx-credential-helper` | No | `.github/tools/qnx_credential_helper.py` | Path (workspace-relative or absolute) to the QNX credential helper script. Use empty string to skip this step. |
| `qnx-user` | Yes | - | QNX account username for qnx.com access. |
| `qnx-password` | Yes | - | QNX account password for qnx.com access. |

## Example

```yaml
jobs:
  qnx-build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup QNX SDP
        uses: eclipse-score/cicd-actions/setup-qnx-sdp@main
        with:
          qnx-license: ${{ secrets.QNX_LICENSE }}
          qnx-license-dir: /opt/qnx/license
          qnx-license-server: ${{ vars.QNX_LICENSE_SERVER }}
          qnx-user: ${{ secrets.QNX_USER }}
          qnx-password: ${{ secrets.QNX_PASSWORD }}

      - name: Build with Bazel
        run: bazel build //...
```

## Output

This action does not define formal action outputs in metadata.

It creates or changes files and environment variables for subsequent workflow steps:

### Environment variables written to GITHUB_ENV

- `QNX_CREDENTIAL_HELPER`:
  - Set only when the credential helper step runs successfully.
  - Contains the absolute path to the credential helper script.

- `QNXLM_LICENSE_FILE`:
  - Set only when `qnx-license-server` is provided.
  - Value is the provided license server string.

- `QNX_LICENSE_EXTSERVER_DELAY`:
  - Set only when `qnx-license-server` is provided.
  - Value is `59`.

- `QNX_LICENSE_QUEUE_TIMEOUT`:
  - Set only when `qnx-license-server` is provided.
  - Value is `180`.

### Files created or modified

- License file:
  - Written to `<qnx-license-dir>/licenses` from decoded `qnx-license` content.

- Bazel user configuration:
  - Appends license-related entries to `user.bazelrc` when `qnx-license-server` is provided and `.bazelrc` exists.

- Netrc:
  - Configures qnx.com credentials in `.netrc` for the duration of the job. Cleans up after the job finishes.
