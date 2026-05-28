# Free Disk Space

Frees disk space on Ubuntu runners by removing pre-installed tools and frameworks that are not needed for most CI/CD jobs. This is a thin wrapper around [`endersonmenezes/free-disk-space`](https://github.com/endersonmenezes/free-disk-space) with opinionated defaults.

## What Gets Removed

- Android SDK
- .NET SDK
- Haskell toolchain
- Tool cache
- Swap
- Additional folders: Swift, Miniconda, Azure tools, Chromium, PowerShell, Julia, AWS CLI, Gradle

## Inputs

None.

## Example

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Free disk space
        uses: eclipse-score/cicd-actions/free-disk-space@<sha1>

      - name: Checkout
        uses: actions/checkout@v4
```

## Notes

- Run this action before `actions/checkout` or any other steps that consume disk space.
- Only works on Ubuntu runners.
