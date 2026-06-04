# Unblock user namespace for linux-sandbox

Some tests require `linux-sandbox`.
Starting with Ubuntu 23.10 Canonical has blocked Linux user namespaces for [security reasons](https://discourse.ubuntu.com/t/spec-unprivileged-user-namespace-restrictions-via-apparmor-in-ubuntu-23-10/37626/1).
This action allows `linux-sandbox` to use Linux user namespaces via configuring `apparmor`.

## Local `linux-sandbox` enabling

To enable `linux-sandbox` locally, when using the devcontainer read the [devcontainer documentation](https://github.com/eclipse-score/devcontainer#bazels-linux-sandbox) for instructions.
