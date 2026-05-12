#!/usr/bin/env bash
# *******************************************************************************
# Copyright (c) 2026 Contributors to the Eclipse Foundation
#
# See the NOTICE file(s) distributed with this work for additional
# information regarding copyright ownership.
#
# This program and the accompanying materials are made available under the
# terms of the Apache License Version 2.0 which is available at
# https://www.apache.org/licenses/LICENSE-2.0
#
# SPDX-License-Identifier: Apache-2.0
# *******************************************************************************
#
# Rebuilds the distribution files (dst/main/index.js and dst/post/index.js) from
# scratch by installing all npm dependencies and bundling the source files with ncc.
# Run this script whenever src/main.js or src/post.js are modified.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

echo "==> Cleaning previous distribution files..."
rm -rf dst/main dst/post

echo "==> Installing npm dependencies..."
npm install
npm ci

echo "==> Linting source files..."
if ! npm run lint -- --format stylish 2>&1; then
  echo "WARNING: ESLint reported findings in the source files (see above). The build will continue."
fi

echo "==> Building distribution files..."
npm run build

echo "==> Done. Distribution files:"
ls -lh dst/main/index.js dst/post/index.js

echo "==> Running pre-commit checks..."
# pre-commit config lives at the repo root; run it from there scoped to this action's files
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
if command -v pre-commit &>/dev/null; then
  if ! pre-commit run --config "${REPO_ROOT}/.pre-commit-config.yaml" \
      --files "${SCRIPT_DIR}"/**/* 2>&1; then
    echo "WARNING: pre-commit reported findings (see above)."
  fi
else
  echo "WARNING: pre-commit not found, skipping checks."
fi
