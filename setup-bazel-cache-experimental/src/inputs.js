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

const BOOLEAN_MODES = new Set(['true', 'false']);
const AUTOMATIC_MODES = new Set(['true', 'false', 'auto']);
const INVALID_BRANCH_CHARACTERS = /[\s~^:?*[\]\\]/;

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

/** Ensure the configured branch can be unambiguously converted to a head ref. */
function parseMainBranch(value) {
  const branch = value.trim();
  if (
    !branch ||
    branch.startsWith('refs/') ||
    branch.startsWith('.') ||
    branch.endsWith('.') ||
    branch.endsWith('.lock') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.includes('..') ||
    branch.includes('//') ||
    INVALID_BRANCH_CHARACTERS.test(branch)
  ) {
    throw new Error(
      `Invalid main-branch value '${value}'. Expected a Git branch name without a refs/ prefix.`,
    );
  }
  return branch;
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

/** Restrict cache writes to the configured branch's canonical Git ref. */
function isCacheSaveRef(ref, mainBranch) {
  return ref === `refs/heads/${mainBranch}`;
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
  parseMainBranch,
  parseRepositoryCacheSave,
  parseRestoreConfiguration,
  resolveRestoreConfiguration,
};
