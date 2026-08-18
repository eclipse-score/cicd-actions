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
const INVALID_BRANCH_PATTERN_CHARACTERS = /[\s~^:\\]/;

/** Reject unknown modes early because GitHub Action inputs are untyped strings. */
function validateMode(name, value, allowed) {
  if (!allowed.has(value)) {
    throw new Error(`Invalid ${name} value '${value}'. Expected ${[...allowed].join(', ')}.`);
  }
}

/** Resolve the public cache modes without applying branch or lock-file policy yet. */
function parseCacheConfiguration(raw) {
  const diskRestore = raw.diskCacheRestore.trim() || 'auto';
  const repositoryRestore = raw.repositoryCacheRestore.trim() || 'auto';
  const diskSave = raw.diskCacheSave.trim() || 'false';
  const repositorySave = raw.repositoryCacheSave.trim() || 'auto';

  validateMode('disk-cache-restore', diskRestore, AUTOMATIC_MODES);
  validateMode('repository-cache-restore', repositoryRestore, AUTOMATIC_MODES);
  validateMode('disk-cache-save', diskSave, AUTOMATIC_MODES);
  validateMode('repository-cache-save', repositorySave, AUTOMATIC_MODES);
  return {
    diskRestore,
    repositoryRestore,
    diskSave,
    repositorySave,
    bazelisk: 'false',
  };
}

/** Ensure a branch name or glob pattern can be safely matched against a head ref. */
function parseBranchPattern(value, name = 'cache-save-branches') {
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

/** Resolve the configured save branches, defaulting to the repository default branch. */
function parseCacheSaveBranches(value, defaultBranch) {
  const patterns = value
    .split(/\r?\n/)
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  if (patterns.length === 0) {
    if (!defaultBranch) {
      throw new Error(
        'Cannot determine the repository default branch. Set cache-save-branches explicitly.',
      );
    }
    return [parseBranchPattern(defaultBranch, 'repository.default_branch')];
  }
  return patterns.map((pattern) => parseBranchPattern(pattern));
}

/** Convert one configured mode into the boolean needed by the cache layer. */
function resolveRestoreMode(mode, cacheSave, lockFileChanged) {
  return mode === 'false' || (mode === 'auto' && cacheSave && lockFileChanged);
}

/** Resolve every cache independently so the cache layer contains no input policy. */
function resolveRestoreConfiguration(configuration, cacheSave, lockFileChanged) {
  return {
    skipBazelisk: false,
    skipDisk: resolveRestoreMode(configuration.diskRestore, cacheSave, lockFileChanged),
    skipRepository: resolveRestoreMode(
      configuration.repositoryRestore,
      cacheSave,
      lockFileChanged,
    ),
  };
}

/** Resolve which cache families may be published on this cache-saving ref. */
function resolveCacheSaveConfiguration(configuration, cacheSave) {
  return {
    disk: cacheSave && configuration.diskSave !== 'false',
    repository: cacheSave && configuration.repositorySave !== 'false',
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
function needsLockFileCheck(configuration, cacheSave) {
  return cacheSave && (
    configuration.diskRestore === 'auto' ||
    configuration.repositoryRestore === 'auto' ||
    configuration.bazelisk === 'auto'
  );
}

export {
  isCacheSaveRef,
  needsLockFileCheck,
  parseBranchPattern,
  parseCacheSaveBranches,
  parseCacheConfiguration,
  resolveCacheSaveConfiguration,
  resolveRestoreConfiguration,
};
