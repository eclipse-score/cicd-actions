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
# Run this script whenever source files are changed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

# Load nvm so the correct Linux Node.js is used even when the script is invoked
# non-interactively (e.g. from a pre-commit hook) where .bashrc is not sourced.
if [[ -z "${NVM_DIR:-}" ]] && [[ -d "${HOME}/.nvm" ]]; then
  export NVM_DIR="${HOME}/.nvm"
fi
if [[ -s "${NVM_DIR}/nvm.sh" ]]; then
  # shellcheck source=/dev/null
  source "${NVM_DIR}/nvm.sh"
fi

echo "==> Installing npm dependencies..."
# Only create package-lock.json since the npm ci call will install the exact versions from it.
npm i --package-lock-only
npm ci

echo "==> Linting source files..."
if ! npm run lint -- --format stylish 2>&1; then
  echo "WARNING: ESLint reported findings in the source files (see above). The build will continue."
fi

echo "==> Building distribution files..."
npm run build

echo "==> Done. Distribution files:"
ls -lh dst/main/index.js dst/post/index.js
