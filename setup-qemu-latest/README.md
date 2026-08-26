# Setup QEMU latest stable version

Reusable composite action that builds QEMU from source, installs it on the runner, validates the selected machine target, and adds it to `PATH`.

The default configuration builds the `aarch64-softmmu` target, which includes Raspberry Pi 4 Model B support (`-machine raspi4b`).

## Usage

Use the action from a GitHub Actions workflow:

```yaml
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4

      - name: Setup QEMU latest
        id: qemu
        uses: eclipse-score/cicd-actions/setup-qemu-latest@main

      - name: Check Raspberry Pi 4B support
        run: qemu-system-aarch64 -machine help
```

Pin the action to a commit SHA for immutable builds:

```yaml
- uses: eclipse-score/cicd-actions/setup-qemu-latest@<commit-sha>
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `qemu-version` | `10.2.4` | QEMU release to download from `download.qemu.org` and build. |
| `qemu-targets` | `aarch64-softmmu` | Comma-separated targets passed to `--target-list`. |
| `install-prefix` | `/opt/qemu` | Base installation directory. The QEMU version is appended. |
| `configure-args` | Empty | Additional flags appended to `./configure`. |
| `extra-build-deps` | Empty | Additional space-separated apt packages required by custom configurations. |
| `nproc` | Automatic | Number of parallel `make` jobs. Empty uses the runner CPU count. |
| `validation-target` | `aarch64` | Target validated with `-machine help`. Empty disables validation. |
| `kvm-mode` | `0666` | Four-digit octal access mode for the `/dev/kvm` device udev rule. |

For example, build multiple targets with a custom configure option:

```yaml
- name: Setup QEMU
  uses: eclipse-score/cicd-actions/setup-qemu-latest@main
  with:
    qemu-targets: aarch64-softmmu,arm-softmmu
    configure-args: --enable-slirp
    nproc: "4"
    kvm-mode: "0660"
```

## Outputs

| Output | Description |
| --- | --- |
| `install-prefix` | Full directory containing the QEMU installation. |
| `cache-key` | Cache key used for the build. |
| `bin-path` | Directory containing the QEMU executables. |

The action adds `bin-path` to `PATH` for subsequent steps in the same job. Outputs are also available through the step ID:

```yaml
- name: Show QEMU location
  run: |
    echo "Install: ${{ steps.qemu.outputs.install-prefix }}"
    echo "Binaries: ${{ steps.qemu.outputs.bin-path }}"
```

## Behavior

- Existing apt-installed `qemu-system*` and `qemu-utils` packages are purged on a cache miss to avoid binary and dependency conflicts with the source-built QEMU version.
- QEMU source archives are verified with the published detached GPG signature before extraction.
- Builds are cached by runner OS, QEMU version, targets, configure arguments, and extra build dependencies.
- Build dependencies remain installed for the rest of the job so later build or test steps can use them.
- KVM device permissions are configured for the runner.

## Requirements

The action is intended for GitHub-hosted Ubuntu runners or compatible Linux runners with:

- `sudo` access
- `apt-get`
- `curl`, `tar`, and `gpg`
- GitHub Actions cache support

This action runs inside a GitHub Actions workflow. It cannot be referenced directly from `devcontainer.json` or used as a local shell setup script.
