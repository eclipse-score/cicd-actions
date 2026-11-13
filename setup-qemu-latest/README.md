# Setup QEMU latest stable version

Reusable composite action that builds QEMU from source, installs it on the runner, validates the selected machine target, and adds it to `PATH`.

The default configuration builds the `aarch64-softmmu` and `x86_64-softmmu` targets. The AArch64 target includes Raspberry Pi 4 Model B support (`-machine raspi4b`).

## Usage

Use the action from a GitHub Actions workflow:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7.0.1

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
| `qemu-version` | `11.1.3` | QEMU release to download from `download.qemu.org` and build. Must match `X.Y.Z` (digits and dots only). |
| `allow-downgrade` | `false` | Build `qemu-version` instead of keeping a newer preinstalled QEMU. An exact version match is always kept. |
| `qemu-targets` | `aarch64-softmmu,x86_64-softmmu` | Comma-separated targets passed to `--target-list`. |
| `install-prefix` | `/opt/qemu` | Base installation directory. Relative paths resolve against `GITHUB_WORKSPACE`; the path is normalized to an absolute path before the QEMU version is appended. Must not be empty. |
| `configure-args` | Empty | Newline-delimited arguments appended to `./configure`; each non-empty line is one argument. |
| `extra-build-deps` | Empty | Additional space-separated apt packages required by custom configurations. Installed on cache hits too, including their transitive runtime libraries. |
| `nproc` | Automatic | Number of parallel `make` jobs. Empty uses the runner CPU count. |
| `validation-target` | `aarch64` | Target validated with `-machine help`. Empty disables validation. |
| `enable-kvm-access` | `false` | Grant the job's runner user ACL read/write access to `/dev/kvm` for the duration of the job; restore the original ACL afterwards. |

For example, build multiple targets with a custom configure option:

```yaml
- name: Setup QEMU
  uses: eclipse-score/cicd-actions/setup-qemu-latest@main
  with:
    qemu-targets: aarch64-softmmu,arm-softmmu
    configure-args: |
      --enable-slirp
      --extra-cflags=-O2 -g
    extra-build-deps: libslirp-dev
    nproc: "4"
```

To replace a newer installed QEMU with the requested version, set `allow-downgrade: "true"`.

## Outputs

| Output | Description |
| --- | --- |
| `install-prefix` | Prefix QEMU was built and installed under. Empty when a preinstalled system QEMU was kept instead. |
| `cache-key` | Cache key used for the build. |
| `cache-hit` | Whether the QEMU build cache was restored (`true`) or missed (`false`); an unset restore output defaults to `false`. |
| `bin-path` | Directory containing the QEMU executables. |

The action adds `bin-path` to `PATH` for subsequent steps in the same job. Outputs are also available through the step ID:

```yaml
- name: Show QEMU location
  run: |
    echo "Install: ${{ steps.qemu.outputs.install-prefix }}"
    echo "Binaries: ${{ steps.qemu.outputs.bin-path }}"
```

## Behavior

- On a cache miss, every requested softmmu or linux-user target must have a recognizable preinstalled QEMU version that meets the version policy, with all executables in the same bin directory. Exact version matches are always kept. Newer versions are kept unless `allow-downgrade` is `true`; an older, missing, or unsupported target triggers a source build of all requested targets. Executables without an owning Debian package do not prevent a source build.
- Version detection accepts both system-emulator banners (`QEMU emulator version X.Y.Z`) and Linux-user banners (`qemu-aarch64 version X.Y.Z`).
- The installation base directory is prepared before cache restore. On a cache miss, the version-specific installation directory is created only when a source build is selected; keeping a preinstalled QEMU does not create that directory.
- QEMU source archives are extracted into a unique directory under `RUNNER_TEMP`; cleanup removes only that directory and leaves similarly named paths in the caller's workspace untouched.
- QEMU source archives are verified with the published detached GPG signature before extraction.
- Builds are cached by runner OS, machine architecture, distribution release, QEMU version, installation prefix, targets, configure arguments, and extra build dependencies.
- Default runtime libraries (GLib, pixman, libfdt, zlib, and the C++/GCC runtimes) and all `extra-build-deps` are installed before cache restore on every invocation. Custom features must declare their packages in `extra-build-deps`; development packages are deliberately installed on cache hits too so their runtime dependencies are provisioned automatically.
- On a cache miss, build dependencies remain installed for the rest of the job so later build or test steps can use them.
- If `enable-kvm-access` is `true` and `/dev/kvm` exists, the job's runner user is granted `rw` access via a POSIX ACL entry (not a global `0666` permission change). Before widening the mask, unrelated named user and group entries and the owning group are restricted to their original effective permissions, so they gain no additional access. The original device ACL, including any existing user entry and mask, is saved before modification and restored once the job finishes, even on failure. Cleanup does nothing if setup never saved an ACL.
- The KVM helper is referenced directly at an immutable commit and downloaded by the runner outside the workspace. Its registered post hook survives subsequent workspace-root checkouts; no workspace alias is created. Updates to the helper require updating the pinned commit in the parent action.

## Tests

The [QEMU test workflow](../.github/workflows/test-setup-qemu-latest.yml) runs local regression tests and covers source builds, cache misses and hits, and the preinstalled-version policy. The cache test builds with SLIRP, removes its packages, and checks that the cache-hit invocation provisions them again before running QEMU. The source-build job enables KVM access from a nonstandard checkout path and then checks out at the workspace root to exercise post-hook survival.

Version-policy tests put fake QEMU executables on `PATH`. These scripts report versions `9.9.9` (exact match) or `99.0.0` (newer version); they are not real QEMU installations. The keep-version tests assert that the fake executable remains active, the `install-prefix` output is empty, and no version-specific installation directory is created.

The downgrade test uses the same fake `99.0.0` version with `allow-downgrade: "true"` and verifies that the requested `11.1.3` is built and takes precedence on `PATH`. Each test job runs on a separate GitHub-hosted runner, so the fake executables do not affect the source-build or cache tests.

Cache keys in the policy and cache tests are isolated by run ID, rerun attempt, and a distinct job label. The cache-hit test removes the first installation before invoking the action again, so it must restore the cached files.

Run the local regression suite with:

```bash
cd setup-qemu-latest
npm ci --ignore-scripts
npm test
```

These tests exercise the actual version-policy shell script with fake executables, post-hook execution after workspace cleanup, cache isolation, and KVM ACL state handling without modifying `/dev/kvm` or requiring `sudo`. The effective-permission tests require `getfacl` and `setfacl` (the Ubuntu `acl` package) and operate only on temporary regular files.

## Requirements

The action is intended for GitHub-hosted Ubuntu runners or compatible Linux runners with:

- GitHub Actions runner version `2.327.1` or newer, required by the Node.js 24 actions used for caching and KVM access; self-hosted runners must be updated accordingly
- `sudo` access
- `apt-get`
- `curl`, `tar`, and `gpg`
- GitHub Actions cache support

This action runs inside a GitHub Actions workflow. It cannot be referenced directly from `devcontainer.json` or used as a local shell setup script.
