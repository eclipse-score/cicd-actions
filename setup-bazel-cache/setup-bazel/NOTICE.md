# Upstream provenance

This internal action is derived from
[`bazel-contrib/setup-bazel`](https://github.com/bazel-contrib/setup-bazel) at
commit `834129750bde586454e5b5343451dd8f3b901d55`. The upstream code is licensed
under the MIT License retained in [`LICENSE`](./LICENSE).

The local patch adds independent disk-cache and repository-cache restore
switches for the public `setup-bazel-cache` wrapper.
