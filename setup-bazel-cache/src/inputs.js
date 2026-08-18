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

import { minimatch } from 'minimatch';

const AUTOMATIC_MODES = new Set(['true', 'false', 'auto']);
const BOOLEAN_MODES = new Set(['true', 'false']);
const INVALID_BRANCH_PATTERN_CHARACTERS = /[\s~^:\\]/;

/** Reject unknown modes early because GitHub Action inputs are untyped strings. */
function validateMode(name, value, allowed) {
  if (!allowed.has(value)) {
    throw new Error(`Invalid ${name} value '${value}'. Expected ${[...allowed].join(', ')}.`);
  }
}

/** Resolve the public cache modes without applying branch or lock-file policy yet. */
function parseCacheConfiguration(raw) {
  const restore = {
    bazelisk: raw.bazeliskCacheRestore.trim() || 'true',
    disk: raw.diskCacheRestore.trim() || 'auto',
    repository: raw.repositoryCacheRestore.trim() || 'auto',
  };
  const save = {
    bazelisk: raw.bazeliskCacheSave.trim() || 'true',
    disk: raw.diskCacheSave.trim() || 'false',
    repository: raw.repositoryCacheSave.trim() || 'auto',
  };

  validateMode('bazelisk-cache-restore', restore.bazelisk, BOOLEAN_MODES);
  validateMode('bazelisk-cache-save', save.bazelisk, BOOLEAN_MODES);
  validateMode('disk-cache-restore', restore.disk, AUTOMATIC_MODES);
  validateMode('repository-cache-restore', restore.repository, AUTOMATIC_MODES);
  validateMode('disk-cache-save', save.disk, AUTOMATIC_MODES);
  validateMode('repository-cache-save', save.repository, AUTOMATIC_MODES);
  return {
    restore,
    save,
  };
}

/** Ensure a branch name or glob pattern can be safely matched against a head ref. */
function parseBranchPattern(value, name = 'cache-save-branch-patterns') {
  const pattern = value.trim();
  if (
    !pattern ||
    pattern.startsWith('refs/') ||
    pattern.startsWith('.') ||
    pattern.endsWith('.') ||
    pattern.endsWith('.lock') ||
    pattern.startsWith('/') ||
    pattern.endsWith('/') ||
    pattern.includes('..') ||
    pattern.includes('//') ||
    INVALID_BRANCH_PATTERN_CHARACTERS.test(pattern)
  ) {
    throw new Error(
      `Invalid ${name} pattern '${value}'. Expected a branch name or glob pattern without a refs/ prefix.`,
    );
  }
  return pattern;
}

/** Resolve the configured save branch patterns, defaulting to the repository default branch. */
function parseCacheSaveBranchPatterns(value, defaultBranch) {
  const patterns = value
    .split(/\r?\n/)
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  if (patterns.length === 0) {
    if (!defaultBranch) {
      throw new Error(
        'Cannot determine the repository default branch. Set cache-save-branch-patterns explicitly.',
      );
    }
    return [parseBranchPattern(defaultBranch, 'repository.default_branch')];
  }
  return patterns.map((pattern) => parseBranchPattern(pattern));
}

/** Resolve one positive restore mode into the decision used by the cache layer. */
function resolveRestoreMode(mode, cacheSaveAllowed, lockFileChanged) {
  return mode !== 'false' && !(mode === 'auto' && cacheSaveAllowed && lockFileChanged);
}

/** Resolve every cache independently so the cache layer contains no input policy. */
function resolveRestoreModes(configuration, cacheSaveAllowed, lockFileChanged) {
  return {
    bazelisk: configuration.bazelisk === 'true',
    disk: resolveRestoreMode(configuration.disk, cacheSaveAllowed, lockFileChanged),
    repository: resolveRestoreMode(configuration.repository, cacheSaveAllowed, lockFileChanged),
  };
}

/** Resolve which cache families may be published on this cache-saving ref. */
function resolveSaveModes(configuration, cacheSaveAllowed) {
  return {
    bazelisk: cacheSaveAllowed && configuration.bazelisk === 'true',
    disk: cacheSaveAllowed && configuration.disk !== 'false',
    repository: cacheSaveAllowed && configuration.repository !== 'false',
  };
}

/** Restrict cache writes to configured branch patterns and never to pull-request refs. */
function isCacheSaveRef(ref, branchPatterns) {
  if (!ref.startsWith('refs/heads/')) return false;
  const branch = ref.slice('refs/heads/'.length);
  return branchPatterns.some((pattern) => minimatch(branch, pattern, {
    dot: true,
    nocomment: true,
    noext: true,
    nonegate: true,
  }));
}

/**
 * Avoid Git inspection unless an automatic decision can affect this run.
 * Non-writing refs always restore and therefore do not need a parent commit.
 */
function needsLockFileCheck(configuration, cacheSaveAllowed) {
  return cacheSaveAllowed && (
    configuration.disk === 'auto' ||
    configuration.repository === 'auto'
  );
}

export {
  isCacheSaveRef,
  needsLockFileCheck,
  parseBranchPattern,
  parseCacheSaveBranchPatterns,
  parseCacheConfiguration,
  resolveRestoreModes,
  resolveSaveModes,
};
