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

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

npm ci
npm run build

# Keep generated third-party code compatible with repository line-ending and
# whitespace checks. Some dependencies embed CRLF source in the bundle.
sed -i 's/\r$//; s/[[:blank:]]\+$//' dst/main/index.js dst/post/index.js
perl -0pi -e 's/\n+\z/\n/' dst/main/index.js dst/post/index.js
