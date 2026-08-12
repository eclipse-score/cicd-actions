// *******************************************************************************
// Copyright (c) 2026 Contributors to the Eclipse Foundation
//
// See the NOTICE file(s) distributed with this work for additional
// information regarding copyright ownership.
//
// This program and the accompanying materials are made available under the
// terms of the Apache License Version 2.0 which is available at
// https://www.apache.org/licenses/LICENSE-2.0
//
// SPDX-License-Identifier: Apache-2.0
// *******************************************************************************

import os from 'node:os';
import path from 'node:path';

/**
 * Build the complete Linux cache configuration in one place. Repository-cache
 * identity intentionally follows only Bzlmod metadata because this action does
 * not support legacy WORKSPACE dependency declarations.
 */
function createConfiguration(workspace, uniqueCacheName) {
  const home = os.homedir();
  const cacheRoot = path.join(home, '.cache');
  const baseKey = `setup-bazel-cache-v1-linux-${os.arch()}`;

  return {
    bazelrc: path.join(home, '.bazelrc'),
    bazelrcContents: [
      `build --disk_cache=${path.join(cacheRoot, 'bazel-disk')}`,
      `common --repository_cache=${path.join(cacheRoot, 'bazel-repo')}`,
      '',
    ].join('\n'),
    cacheSaveState: 'setup-bazel-cache-configuration',
    caches: {
      bazelisk: {
        name: 'bazelisk',
        files: [path.join(workspace, '.bazelversion')],
        paths: [path.join(cacheRoot, 'bazelisk')],
      },
      disk: {
        name: `disk-${uniqueCacheName}`,
        optimized: true,
        files: [],
        paths: [path.join(cacheRoot, 'bazel-disk')],
      },
      repository: {
        name: 'repository',
        files: [
          path.join(workspace, 'MODULE.bazel'),
          path.join(workspace, 'MODULE.bazel.lock'),
        ],
        paths: [path.join(cacheRoot, 'bazel-repo')],
      },
    },
    baseKey,
    workspace,
  };
}

export { createConfiguration };
