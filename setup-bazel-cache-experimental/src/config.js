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

const MAX_UNIQUE_CACHE_NAME_LENGTH = 400;

/** Reject malformed key components before cache APIs can fail late in the job. */
function validateUniqueCacheName(value) {
  if (
    !value ||
    value.length > MAX_UNIQUE_CACHE_NAME_LENGTH ||
    hasControlCharacter(value) ||
    value.includes(',')
  ) {
    throw new Error(
      'unique-cache-name must contain 1 to 400 printable characters without commas.',
    );
  }
  return value;
}

function hasControlCharacter(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint < 32 || codePoint === 127;
  });
}

/** Build the complete Linux cache configuration in one place. */
function createConfiguration(workspace, uniqueCacheName) {
  validateUniqueCacheName(uniqueCacheName);
  const home = os.homedir();
  const cacheRoot = path.join(home, '.cache');
  const runnerTemp = process.env.RUNNER_TEMP || os.tmpdir();
  const baseKey = `setup-bazel-cache-experimental-v1-linux-${os.arch()}`;

  return {
    additiveCacheSaveEnvironment:
      'SETUP_BAZEL_CACHE_EXPERIMENTAL_ADDITIVE_SAVE',
    bazelrc: path.join(runnerTemp, 'setup-bazel-cache-experimental.bazelrc'),
    bazelrcContents: [
      `build --disk_cache=${path.join(cacheRoot, 'bazel-disk')}`,
      `common --repository_cache=${path.join(cacheRoot, 'bazel-repo')}`,
      '',
    ].join('\n'),
    cacheSaveState: 'setup-bazel-cache-experimental-configuration',
    caches: {
      bazelisk: {
        name: 'bazelisk',
        files: [path.join(workspace, '.bazelversion')],
        paths: [path.join(cacheRoot, 'bazelisk')],
      },
      disk: {
        name: `disk-${uniqueCacheName.length}-${uniqueCacheName}`,
        generational: true,
        files: [],
        paths: [path.join(cacheRoot, 'bazel-disk')],
      },
      repository: {
        name: 'repository',
        generational: true,
        files: [],
        paths: [path.join(cacheRoot, 'bazel-repo')],
      },
    },
    baseKey,
    workspace,
  };
}

export { createConfiguration, validateUniqueCacheName };
