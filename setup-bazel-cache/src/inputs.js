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

const BOOLEAN_MODES = new Set(['true', 'false']);
const AUTOMATIC_MODES = new Set(['true', 'false', 'auto']);
const INVALID_BRANCH_PATTERN_CHARACTERS = /[\s~^:\\]/;

/** Reject unknown modes early because GitHub Action inputs are untyped strings. */
function validateMode(name, value, allowed) {
  if (!allowed.has(value)) {
    throw new Error(`Invalid ${name} value '${value}'. Expected ${[...allowed].join(', ')}.`);
  }
}

/** Resolve the public restore inputs without applying the lock-file decision yet. */
function parseRestoreConfiguration(raw) {
  const disk = raw.skipDiskCacheRestore.trim();
  const repository = raw.skipRepositoryCacheRestore.trim();

  const resolvedDisk = disk || 'auto';
  const resolvedRepository = repository || 'false';
  validateMode('skip-disk-cache-restore', resolvedDisk, AUTOMATIC_MODES);
  validateMode('skip-repository-cache-restore', resolvedRepository, BOOLEAN_MODES);
  return { disk: resolvedDisk, repository: resolvedRepository, bazelisk: 'false' };
}

/** Resolve whether this job is a publisher for the shared repository cache. */
function parseRepositoryCacheSave(value) {
  const resolved = value.trim() || 'true';
  validateMode('save-repository-cache', resolved, BOOLEAN_MODES);
  return resolved === 'true';
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
function resolveMode(mode, cacheSave, lockFileChanged) {
  return mode === 'true' || (mode === 'auto' && cacheSave && lockFileChanged);
}

/** Resolve every cache independently so the cache layer contains no input policy. */
function resolveRestoreConfiguration(configuration, cacheSave, lockFileChanged) {
  return {
    skipBazelisk: resolveMode(configuration.bazelisk, cacheSave, lockFileChanged),
    skipDisk: resolveMode(configuration.disk, cacheSave, lockFileChanged),
    skipRepository: resolveMode(configuration.repository, cacheSave, lockFileChanged),
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
    configuration.disk === 'auto' ||
    configuration.repository === 'auto' ||
    configuration.bazelisk === 'auto'
  );
}

export {
  isCacheSaveRef,
  needsLockFileCheck,
  parseBranchPattern,
  parseCacheSaveBranches,
  parseRepositoryCacheSave,
  parseRestoreConfiguration,
  resolveRestoreConfiguration,
};
