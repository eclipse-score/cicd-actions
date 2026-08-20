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

/** Remove the action-managed import block while preserving user configuration. */
function removeManagedBazelrcBlock(contents) {
  const start = contents.indexOf(BAZELRC_MARKER_START);
  if (start < 0) return contents;

  const end = contents.indexOf(BAZELRC_MARKER_END, start);
  if (end < 0) return contents;

  const afterEnd = end + BAZELRC_MARKER_END.length;
  const newlineAfterEnd = contents[afterEnd] === '\n' ? 1 : 0;
  return contents.slice(0, start) + contents.slice(afterEnd + newlineAfterEnd);
}

/** Add the generated cache rc as an import to Bazel 8's standard user rc. */
function installManagedBazelrc(configuration) {
  let contents = '';
  try {
    contents = fs.readFileSync(configuration.userBazelrc, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const cleaned = removeManagedBazelrcBlock(contents);
  const separator = cleaned && !cleaned.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(
    configuration.userBazelrc,
    `${cleaned}${separator}${configuration.bazelrcImport}`,
  );
}

/** Remove the temporary import from the standard user rc after the job. */
function removeManagedBazelrc(configuration) {
  let contents;
  try {
    contents = fs.readFileSync(configuration.userBazelrc, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  const cleaned = removeManagedBazelrcBlock(contents);
  if (cleaned === contents) return;
  if (cleaned === '') {
    fs.unlinkSync(configuration.userBazelrc);
  } else {
    fs.writeFileSync(configuration.userBazelrc, cleaned);
  }
}

/** Build the complete Linux cache configuration in one place. */
function createConfiguration(workspace, diskCacheKey, { bazeliskVersion } = {}) {
  validateDiskCacheKey(diskCacheKey);
  const resolvedBazeliskVersion = bazeliskVersion === undefined
    ? readBazeliskVersion(workspace)
    : validateBazeliskVersion(bazeliskVersion);
  const home = os.homedir();
  const cacheRoot = path.join(home, '.cache');
  const runnerTemp = process.env.RUNNER_TEMP || os.tmpdir();
  const baseKey = `setup-bazel-cache-v1-linux-${os.arch()}`;

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
    bazelrcContents: [
      `build --disk_cache=${path.join(cacheRoot, 'bazel-disk')}`,
      `common --repository_cache=${path.join(cacheRoot, 'bazel-repo')}`,
      '',
    ].join('\n'),
    cacheSaveState: 'setup-bazel-cache-configuration',
    userBazelrc: path.join(home, '.bazelrc'),
    caches: {
      bazelisk: {
        name: 'bazelisk',
        files: [],
        keySuffix: resolvedBazeliskVersion,
        paths: [path.join(cacheRoot, 'bazelisk')],
      },
      disk: {
        name: `disk-${diskCacheKey.length}-${diskCacheKey}`,
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

export {
  createConfiguration,
  installManagedBazelrc,
  readBazeliskVersion,
  removeManagedBazelrc,
  removeManagedBazelrcBlock,
  validateDiskCacheKey,
};
