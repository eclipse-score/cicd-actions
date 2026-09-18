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
const AUTO_RESTORE_MODES = new Set(['true', 'false', 'auto']);
const REPOSITORY_SAVE_MODES = new Set(['true', 'false', 'auto']);
const INVALID_BRANCH_PATTERN_CHARACTERS = /[\s~^:\\]/;
const DEFAULT_REPOSITORY_CACHE_GROWTH_THRESHOLD = 10;

/** Parse the repository cache growth threshold as a whole percentage. */
function parseRepositoryCacheGrowthThreshold(value) {
  const threshold = value.trim();
  if (!threshold) return DEFAULT_REPOSITORY_CACHE_GROWTH_THRESHOLD;

  if (!/^(0|[1-9]\d*)$/.test(threshold) || Number(threshold) > 100) {
    throw new Error(
      `Invalid repository-cache-growth-threshold value '${value}'. Expected an integer from 0 to 100.`,
    );
  }
  return Number(threshold);
}

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
    external: raw.externalCacheRestore.trim() || 'true',
    repository: raw.repositoryCacheRestore.trim() || 'auto',
  };
  const save = {
    bazelisk: raw.bazeliskCacheSave.trim() || 'true',
    disk: raw.diskCacheSave.trim() || 'false',
    external: raw.externalCacheSave.trim() || 'true',
    repository: raw.repositoryCacheSave.trim() || 'auto',
  };

  validateMode('bazelisk-cache-restore', restore.bazelisk, BOOLEAN_MODES);
  validateMode('bazelisk-cache-save', save.bazelisk, BOOLEAN_MODES);
  validateMode('disk-cache-restore', restore.disk, AUTO_RESTORE_MODES);
  validateMode('external-cache-restore', restore.external, BOOLEAN_MODES);
  validateMode('repository-cache-restore', restore.repository, AUTO_RESTORE_MODES);
  validateMode('disk-cache-save', save.disk, BOOLEAN_MODES);
  validateMode('external-cache-save', save.external, BOOLEAN_MODES);
  validateMode('repository-cache-save', save.repository, REPOSITORY_SAVE_MODES);
  return {
    restore,
    save,
    repositoryCacheGrowthThreshold: parseRepositoryCacheGrowthThreshold(
      raw.repositoryCacheGrowthThreshold || '',
    ),
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
function resolveRestoreMode(mode, cacheWillSave, lockFileChanged) {
  return mode !== 'false' && !(mode === 'auto' && cacheWillSave && lockFileChanged);
}

/** Resolve every cache independently so the cache layer contains no input policy. */
function resolveRestoreModes(configuration, saves, lockFileChanged) {
  return {
    bazelisk: configuration.bazelisk === 'true',
    disk: resolveRestoreMode(configuration.disk, saves.disk, lockFileChanged),
    external: configuration.external === 'true',
    repository: resolveRestoreMode(configuration.repository, saves.repository, lockFileChanged),
  };
}

/** Resolve which cache families may be published on this cache-saving ref. */
function resolveSaveModes(configuration, cacheSaveAllowed) {
  return {
    bazelisk: cacheSaveAllowed && configuration.bazelisk === 'true',
    disk: cacheSaveAllowed && configuration.disk === 'true',
    external: cacheSaveAllowed && configuration.external === 'true',
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

/** Explain why a ref cannot publish a cache, keeping policy failures actionable. */
function cacheSaveDisallowReason(ref, branchPatterns) {
  if (isCacheSaveRef(ref, branchPatterns)) return null;
  if (!ref) return 'GITHUB_REF is empty';
  if (ref.startsWith('refs/pull/')) return 'pull request refs cannot save caches';
  if (ref.startsWith('refs/tags/')) return 'tag refs cannot save caches';
  if (!ref.startsWith('refs/heads/')) {
    return 'ref is not a branch ref (only refs/heads/* may save caches)';
  }
  return 'branch does not match cache-save-branch-patterns';
}

/**
 * Avoid Git inspection unless an automatic restore decision can affect this run.
 * A cache that will not be saved later always restores and needs no parent commit.
 */
function needsLockFileCheck(configuration, saves) {
  return (saves.disk && configuration.disk === 'auto') ||
    (saves.repository && configuration.repository === 'auto');
}

export {
  cacheSaveDisallowReason,
  isCacheSaveRef,
  needsLockFileCheck,
  parseBranchPattern,
  parseCacheSaveBranchPatterns,
  parseCacheConfiguration,
  resolveRestoreModes,
  resolveSaveModes,
};
