# Prune Cache

## Description

Keeps only the newest GitHub Actions cache generation per cache family, per Git ref, deleting older generations to free cache storage.

Cache keys are expected to end in a hexadecimal hash preceded by `-` or `_` (for example `bazel-linux-a1b2c3d4`). Everything before that suffix is the cache *family*. Within each Git ref and family, the newest cache is retained and older generations are deleted. Keys without a matching hash suffix are ignored.

Grouping by Git ref ensures a cache from one branch or pull request never causes a cache belonging to another ref to be deleted.

## Inputs

| Name | Mandatory | Default | Description |
| --- | --- | --- | --- |
| `token` | No | `${{ github.token }}` | GitHub token used to list and delete Actions caches. |
| `dry-run` | No | `false` | Debugging flag. When `true`, report the obsolete caches that would be deleted without deleting them. |

## Required permissions

This action calls the GitHub Actions cache APIs and needs:

- `actions: write` to delete obsolete caches
- `actions: read` is sufficient when running with `dry-run: "true"` (reporting only)

## Example

```yaml
- name: Prune obsolete Bazel caches
  uses: eclipse-score/cicd-actions/prune-cache@main
```

By default the action deletes obsolete cache generations. Set `dry-run: "true"` to only report what would be deleted without deleting anything.
