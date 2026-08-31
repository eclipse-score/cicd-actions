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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { profilePaths } from './profiling.js';

const MAX_BAZELISK_VERSION_LENGTH = 400;
const MAX_DISK_CACHE_KEY_LENGTH = 400;
const BAZELRC_MARKER_START = '# setup-bazel-cache: begin managed import';
const BAZELRC_MARKER_END = '# setup-bazel-cache: end managed import';

/** Reject malformed key components before cache APIs can fail late in the job. */
function validateDiskCacheKey(value) {
  if (
    !value ||
    value.length > MAX_DISK_CACHE_KEY_LENGTH ||
    hasControlCharacter(value) ||
    value.includes(',')
  ) {
    throw new Error(
      'disk-cache-key must contain 1 to 400 printable characters without commas.',
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

/** Validate a Bazelisk version before it becomes part of a cache key. */
function validateBazeliskVersion(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > MAX_BAZELISK_VERSION_LENGTH ||
    hasControlCharacter(value) ||
    value.includes(',')
  ) {
    throw new Error(
      '.bazelversion must contain 1 to 400 printable characters without commas.',
    );
  }
  return value;
}

/** Read the human-readable Bazelisk version used as the exact cache key suffix. */
function readBazeliskVersion(workspace) {
  const versionFile = path.join(workspace, '.bazelversion');
  let version;
  try {
    version = fs.readFileSync(versionFile, 'utf8').trim();
  } catch (error) {
    if (error.code === 'ENOENT') return 'default';
    throw error;
  }
  return validateBazeliskVersion(version);
}

/** Add the generated cache rc as an import to Bazel 8's standard user rc. */
function installManagedBazelrc(configuration) {
  let contents = '';
  try {
    contents = fs.readFileSync(configuration.userBazelrc, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const separator = contents && !contents.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(
    configuration.userBazelrc,
    `${separator}${configuration.bazelrcImport}`,
  );
}

/** Build the complete Linux cache configuration in one place. */
function createConfiguration(
  workspace,
  diskCacheKey,
  { bazeliskVersion, enableProfiling = false } = {},
) {
  validateDiskCacheKey(diskCacheKey);
  const resolvedBazeliskVersion = bazeliskVersion === undefined
    ? readBazeliskVersion(workspace)
    : validateBazeliskVersion(bazeliskVersion);
  const home = os.homedir();
  const cacheRoot = path.join(home, '.cache');
  const runnerTemp = process.env.RUNNER_TEMP || os.tmpdir();
  const baseKey = `setup-bazel-cache-v1-linux-${os.arch()}`;
  const profiles = enableProfiling ? profilePaths(runnerTemp) : null;
  const bazelrcLines = [
    `build --disk_cache=${path.join(cacheRoot, 'bazel-disk')}`,
    `common --repository_cache=${path.join(cacheRoot, 'bazel-repo')}`,
  ];
  if (profiles) {
    bazelrcLines.push(
      `build --profile=${profiles.build}`,
      `test --profile=${profiles.test}`,
    );
  }

  return {
    additiveCacheSaveEnvironment:
      'SETUP_BAZEL_CACHE_ADDITIVE_SAVE',
    bazelrc: path.join(runnerTemp, 'setup-bazel-cache.bazelrc'),
    bazelrcImport: [
      BAZELRC_MARKER_START,
      `try-import ${path.join(runnerTemp, 'setup-bazel-cache.bazelrc')}`,
      BAZELRC_MARKER_END,
      '',
    ].join('\n'),
    bazelrcContents: `${bazelrcLines.join('\n')}\n`,
    cacheSaveState: 'setup-bazel-cache-configuration',
    userBazelrc: path.join(home, '.bazelrc'),
    caches: {
      bazelisk: {
        name: 'bazelisk',
        files: [],
        keySuffix: resolvedBazeliskVersion,
        path: path.join(cacheRoot, 'bazelisk'),
      },
      disk: {
        name: `disk-${diskCacheKey.length}-${diskCacheKey}`,
        generational: true,
        files: [],
        path: path.join(cacheRoot, 'bazel-disk'),
      },
      repository: {
        name: 'repository',
        generational: true,
        files: [],
        path: path.join(cacheRoot, 'bazel-repo'),
      },
    },
    baseKey,
    profiles,
    workspace,
  };
}

export {
  createConfiguration,
  installManagedBazelrc,
  readBazeliskVersion,
  validateDiskCacheKey,
};
