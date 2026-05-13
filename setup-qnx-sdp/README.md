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
2. Checks whether qnx.com credential helper exists and computes absolute path of it (only when `qnx-credential-helper` input is not empty).
3. Prepare QNX license file.
4. Configures qnx license server (only when `qnx-license-server` input is not empty):
   - Appends Bazel flags to `user.bazelrc` for build and test environments.
   - Checks both `$GITHUB_WORKSPACE/.bazelrc` and `$HOME/.bazelrc` for the line `try-import %workspace%/user.bazelrc`. If neither file contains it, a warning is logged (the action continues regardless).
   - Exports license-related environment variables to `GITHUB_ENV`.
5. Configure access to qnx.com via `.netrc`.

After the job completes (always, even on failure or cancellation), the post-action automatically removes the QNX license directory and the `.netrc` entry created in steps 3 and 5.

## Technical constraints

This action is designed to run on Linux/Posix runners. Also depending on the path provided in `qnx-license-dir`, it may require password less sudo access to create the license file and directory. The action will attempt to use `sudo` only when necessary, but the runner environment must allow it.

## Inputs

| Name | Mandatory | Default | Description |
| --- | --- | --- | --- |
| `qnx-license` | Yes | - | Base64 encoded QNX client license file content. Will be decoded and written to the file specified by `qnx-license-dir`/licenses. |
| `qnx-license-dir` | Yes | `/opt/score_qnx/license` | Directory where the `licenses` file is created by decoding the content of `qnx-license`. Supports absolute paths and `~/...`. Absolute paths must be at least two filesystem levels deep (e.g. `/opt/qnx/license`); a path directly under the filesystem root (e.g. `/qnx`) is rejected with an error to prevent accidental operations near the root. |
| `qnx-license-server` | No | - | QNX license server address, for example `6287@license-server-hostname`. If set, license server settings are configured for the job via environment variables and for Bazel by adding entries to the user.bazelrc file. Given client license content `qnx-license` must be compatible with the given license server. For a non-commercial QNX SDP a license server is not required. |
| `qnx-user` | Yes | - | QNX account username for qnx.com access. |
| `qnx-password` | Yes | - | QNX account password for qnx.com access. |
| `qnx-credential-helper` | No | `.github/tools/qnx_credential_helper.py` | Path (workspace-relative or absolute) to the script that Bazel uses to access qnx.com with the provided credentials `qnx-user` and `qnx-password`. |

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
  - Appends license-related entries to `user.bazelrc` when `qnx-license-server` is provided.

- Netrc:
  - Configures qnx.com credentials in `.netrc` for the duration of the job. Cleans up after the job finishes.
