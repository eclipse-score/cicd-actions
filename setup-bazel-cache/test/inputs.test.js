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

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isCacheSaveRef,
  needsLockFileCheck,
  parseBranchPattern,
  parseCacheSaveBranches,
  parseRepositoryCacheSave,
  parseRestoreConfiguration,
  resolveRestoreConfiguration,
} from '../src/inputs.js';

/** Supply every optional raw input so individual tests only override relevant values. */
function raw(overrides = {}) {
  return {
    skipDiskCacheRestore: '',
    skipRepositoryCacheRestore: '',
    ...overrides,
  };
}

test('only configured branch patterns can save caches', () => {
  assert.equal(isCacheSaveRef('refs/heads/main', ['main']), true);
  assert.equal(isCacheSaveRef('refs/heads/feature', ['main']), false);
  assert.equal(isCacheSaveRef('refs/heads/release/1.0', ['master', 'release/*']), true);
  assert.equal(isCacheSaveRef('refs/heads/release/1.0/hotfix', ['release/*']), false);
  assert.equal(isCacheSaveRef('refs/heads/release/1.0/hotfix', ['release/**']), true);
  assert.equal(isCacheSaveRef('refs/pull/123/merge', ['**']), false);
});

test('repository cache publishing defaults to enabled and accepts explicit booleans', () => {
  assert.equal(parseRepositoryCacheSave(''), true);
  assert.equal(parseRepositoryCacheSave('true'), true);
  assert.equal(parseRepositoryCacheSave('false'), false);
  assert.throws(() => parseRepositoryCacheSave('auto'), /Invalid save-repository-cache/);
});

test('cache save patterns default to the repository default branch', () => {
  assert.deepEqual(parseCacheSaveBranches('', 'main'), ['main']);
  assert.deepEqual(
    parseCacheSaveBranches('\nmaster\nrelease/*\n', undefined),
    ['master', 'release/*'],
  );
});

test('branch patterns must not be Git refs or unsafe path-like values', () => {
  assert.equal(parseBranchPattern('release/1.0'), 'release/1.0');
  assert.equal(parseBranchPattern('release/*'), 'release/*');
  assert.throws(() => parseCacheSaveBranches('', undefined), /Cannot determine/);
  assert.throws(() => parseBranchPattern(''), /Invalid cache-save-branches pattern/);
  assert.throws(() => parseBranchPattern('refs/heads/main'), /without a refs\/ prefix/);
  assert.throws(() => parseBranchPattern('main branch'), /Invalid cache-save-branches/);
  assert.throws(() => parseBranchPattern('release/../*'), /Invalid cache-save-branches/);
});

test('new API has auto disk and restoring repository defaults', () => {
  const configuration = parseRestoreConfiguration(raw());
  assert.deepEqual(configuration, {
    disk: 'auto',
    repository: 'false',
    bazelisk: 'false',
  });
  assert.equal(needsLockFileCheck(configuration, true), true);
  assert.deepEqual(resolveRestoreConfiguration(configuration, true, true), {
    skipBazelisk: false,
    skipDisk: true,
    skipRepository: false,
  });
});

test('auto disk mode restores outside the cache-writing branch', () => {
  const configuration = parseRestoreConfiguration(raw());
  assert.equal(needsLockFileCheck(configuration, false), false);
  assert.equal(resolveRestoreConfiguration(configuration, false, true).skipDisk, false);
});

test('explicit modes do not need the lock-file comparison', () => {
  const configuration = parseRestoreConfiguration(raw({
    skipDiskCacheRestore: 'true',
    skipRepositoryCacheRestore: 'true',
  }));
  assert.equal(needsLockFileCheck(configuration, true), false);
  assert.deepEqual(resolveRestoreConfiguration(configuration, true, false), {
    skipBazelisk: false,
    skipDisk: true,
    skipRepository: true,
  });
});

test('invalid modes are rejected', () => {
  assert.throws(
    () => parseRestoreConfiguration(raw({ skipDiskCacheRestore: 'yes' })),
    /Invalid skip-disk-cache-restore/
  );
  assert.throws(
    () => parseRestoreConfiguration(raw({ skipRepositoryCacheRestore: 'auto' })),
    /Invalid skip-repository-cache-restore/
  );
});
