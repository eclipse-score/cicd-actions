# Contributing

Thanks for your interest in contributing!

## Development

This action intentionally has **no runtime dependencies** and **no build step**.

Requirements:

- Ubuntu 24.04 (or similar Linux distribution)
- Node.js 24+
- GitHub CLI (`gh`), used only to obtain a token for local runs

Authenticate once:

```bash
gh auth login
```

## Running locally

```bash
export GITHUB_TOKEN="$(gh auth token)"
export GITHUB_REPOSITORY="eclipse-score/test-repository"
export INPUT_DRY_RUN="true"

node index.js
```

To actually delete caches:

```bash
export INPUT_DRY_RUN="false"

node index.js
```

## Design goals

Please keep the action:

- dependency-free
- build-free
- easy to understand
- opinionated rather than configurable (YAGNI/KISS)

New configuration options should only be added when they solve a demonstrated use case.
