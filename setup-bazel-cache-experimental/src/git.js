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
import fs from 'node:fs';

const FALLBACK_COMPARISON_BASE = 'HEAD^';
const NULL_SHA = '0'.repeat(40);
const SHA_PATTERN = /^[0-9a-f]{40}$/;

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

/** Resolve the start of a push, falling back to the previous commit for other events. */
function resolveComparisonBase(
  eventName = process.env.GITHUB_EVENT_NAME,
  eventPath = process.env.GITHUB_EVENT_PATH,
  readFile = fs.readFileSync,
) {
  if (eventName !== 'push') return FALLBACK_COMPARISON_BASE;
  if (!eventPath) {
    throw new Error('GITHUB_EVENT_PATH is not set for this push event.');
  }

  const event = JSON.parse(readFile(eventPath, 'utf8'));
  if (typeof event.before !== 'string' || !SHA_PATTERN.test(event.before)) {
    throw new Error("The workflow event's 'before' value is not a valid Git commit SHA.");
  }
  return event.before === NULL_SHA ? FALLBACK_COMPARISON_BASE : event.before;
}

/**
 * Ensure the comparison base exists locally. Push events compare the complete
 * pushed range; other events fall back to the previous commit.
 */
function ensureComparisonHistory(workspace, comparisonBase, git = runGit) {
  if (!succeeds(git(workspace, ['rev-parse', '--is-inside-work-tree'], { quiet: true }))) {
    throw new Error(
      'Automatic disk-cache restore detection needs a repository checkout with at least two commits.'
    );
  }

  if (succeeds(git(
    workspace,
    ['rev-parse', '--verify', `${comparisonBase}^{commit}`],
    { quiet: true },
  ))) {
    return 'existing';
  }

  const fetchArguments = comparisonBase === FALLBACK_COMPARISON_BASE
    ? ['fetch', '--no-tags', '--deepen=1', 'origin']
    : ['fetch', '--no-tags', '--depth=1', 'origin', comparisonBase];
  const fetch = git(workspace, fetchArguments, {
    quiet: true,
    env: { GIT_TERMINAL_PROMPT: '0' },
  });
  if (succeeds(fetch) && succeeds(git(
    workspace,
    ['rev-parse', '--verify', `${comparisonBase}^{commit}`],
    { quiet: true },
  ))) {
    return comparisonBase === FALLBACK_COMPARISON_BASE ? 'deepened' : 'fetched';
  }

  throw new Error(
    `Automatic disk-cache restore detection could not obtain ${comparisonBase}. ` +
    "Run actions/checkout with fetch-depth: 0 or set 'skip-disk-cache-restore' explicitly."
  );
}

/** Compare only the pushed lock file; unrelated source changes must not invalidate the disk cache. */
function lockFileChanged(workspace, comparisonBase, git = runGit) {
  const result = git(
    workspace,
    ['diff', '--quiet', comparisonBase, 'HEAD', '--', 'MODULE.bazel.lock'],
  );
  if (result.status === 0) return false;
  if (result.status === 1) return true;
  throw new Error(`Could not compare MODULE.bazel.lock: ${result.stderr || 'git diff failed'}`);
}

export { ensureComparisonHistory, lockFileChanged, resolveComparisonBase };
