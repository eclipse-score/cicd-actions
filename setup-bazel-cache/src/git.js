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

import * as childProcess from 'node:child_process';

/** Run Git without a shell so workspace paths and arguments stay literal. */
function runGit(workspace, args, options = {}) {
  return childProcess.spawnSync('git', ['-C', workspace, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    stdio: options.quiet ? 'ignore' : 'pipe',
  });
}

/** Make spawnSync status checks readable at each Git decision point. */
function succeeds(result) {
  return result.status === 0;
}

/**
 * Ensure HEAD^ exists for the lock-file comparison. A normal checkout is
 * shallow, so deepen it minimally without replacing the caller's checkout.
 */
function ensureComparisonHistory(workspace, git = runGit) {
  if (!succeeds(git(workspace, ['rev-parse', '--is-inside-work-tree'], { quiet: true }))) {
    throw new Error(
      'Automatic disk-cache restore detection needs a repository checkout with at least two commits.'
    );
  }

  if (succeeds(git(workspace, ['rev-parse', '--verify', 'HEAD^'], { quiet: true }))) {
    return 'existing';
  }

  const fetch = git(workspace, ['fetch', '--no-tags', '--deepen=1', 'origin'], {
    quiet: true,
    env: { GIT_TERMINAL_PROMPT: '0' },
  });
  if (succeeds(fetch) && succeeds(git(workspace, ['rev-parse', '--verify', 'HEAD^'], { quiet: true }))) {
    return 'deepened';
  }

  throw new Error(
    'Automatic disk-cache restore detection could not obtain the previous commit. ' +
    "Run actions/checkout with fetch-depth: 2 or set 'skip-disk-cache-restore' explicitly."
  );
}

/** Compare only the committed lock file; unrelated source changes must not invalidate the disk cache. */
function lockFileChanged(workspace, git = runGit) {
  const result = git(workspace, ['diff', '--quiet', 'HEAD^', 'HEAD', '--', 'MODULE.bazel.lock']);
  if (result.status === 0) return false;
  if (result.status === 1) return true;
  throw new Error(`Could not compare MODULE.bazel.lock: ${result.stderr || 'git diff failed'}`);
}

export { ensureComparisonHistory, lockFileChanged };
