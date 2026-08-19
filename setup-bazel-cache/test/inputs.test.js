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
  parseCacheSaveBranchPatterns,
  parseCacheConfiguration,
  resolveRestoreModes,
  resolveSaveModes,
} from '../src/inputs.js';

/** Supply every optional raw input so individual tests only override relevant values. */
function raw(overrides = {}) {
  return {
    bazeliskCacheRestore: '',
    bazeliskCacheSave: '',
    diskCacheRestore: '',
    repositoryCacheRestore: '',
    diskCacheSave: '',
    repositoryCacheSave: '',
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

test('cache save patterns default to the repository default branch', () => {
  assert.deepEqual(parseCacheSaveBranchPatterns('', 'main'), ['main']);
  assert.deepEqual(
    parseCacheSaveBranchPatterns('\nmaster\nrelease/*\n', undefined),
    ['master', 'release/*'],
  );
});

test('branch patterns must not be Git refs or unsafe path-like values', () => {
  assert.equal(parseBranchPattern('release/1.0'), 'release/1.0');
  assert.equal(parseBranchPattern('release/*'), 'release/*');
  assert.throws(() => parseCacheSaveBranchPatterns('', undefined), /Cannot determine/);
  assert.throws(() => parseBranchPattern(''), /Invalid cache-save-branch-patterns pattern/);
  assert.throws(() => parseBranchPattern('refs/heads/main'), /without a refs\/ prefix/);
  assert.throws(() => parseBranchPattern('main branch'), /Invalid cache-save-branch-patterns/);
  assert.throws(() => parseBranchPattern('release/../*'), /Invalid cache-save-branch-patterns/);
});

test('new cache API uses the requested defaults', () => {
  const configuration = parseCacheConfiguration(raw());
  assert.deepEqual(configuration, {
    restore: {
      bazelisk: 'true',
      disk: 'auto',
      repository: 'true',
    },
    save: {
      bazelisk: 'true',
      disk: 'false',
      repository: 'true',
    },
  });
  assert.equal(needsLockFileCheck(configuration.restore, true), true);
  assert.deepEqual(resolveRestoreModes(configuration.restore, true, true), {
    bazelisk: true,
    disk: false,
    repository: true,
  });
  assert.deepEqual(resolveSaveModes(configuration.save, true), {
    bazelisk: true,
    disk: false,
    repository: true,
  });
});

test('automatic disk restore mode restores outside the cache-writing branch', () => {
  const configuration = parseCacheConfiguration(raw());
  assert.equal(needsLockFileCheck(configuration.restore, false), false);
  assert.deepEqual(resolveRestoreModes(configuration.restore, false, true), {
    bazelisk: true,
    disk: true,
    repository: true,
  });
});

test('explicit modes do not need the lock-file comparison', () => {
  const configuration = parseCacheConfiguration(raw({
    diskCacheRestore: 'false',
    repositoryCacheRestore: 'false',
  }));
  assert.equal(needsLockFileCheck(configuration.restore, true), false);
  assert.deepEqual(resolveRestoreModes(configuration.restore, true, false), {
    bazelisk: true,
    disk: false,
    repository: false,
  });
});

test('invalid modes are rejected', () => {
  assert.throws(
    () => parseCacheConfiguration(raw({ diskCacheRestore: 'yes' })),
    /Invalid disk-cache-restore/
  );
  assert.throws(
    () => parseCacheConfiguration(raw({ repositoryCacheSave: 'yes' })),
    /Invalid repository-cache-save/
  );
  assert.throws(
    () => parseCacheConfiguration(raw({ repositoryCacheRestore: 'auto' })),
    /Invalid repository-cache-restore/
  );
  assert.throws(
    () => parseCacheConfiguration(raw({ diskCacheSave: 'auto' })),
    /Invalid disk-cache-save/
  );
  assert.throws(
    () => parseCacheConfiguration(raw({ bazeliskCacheRestore: 'yes' })),
    /Invalid bazelisk-cache-restore/
  );
  assert.throws(
    () => parseCacheConfiguration(raw({ bazeliskCacheSave: 'yes' })),
    /Invalid bazelisk-cache-save/
  );
});

test('Bazelisk uses boolean modes independently of lock-file policy', () => {
  const configuration = parseCacheConfiguration(raw({
    bazeliskCacheRestore: 'true',
    bazeliskCacheSave: 'false',
  }));
  assert.deepEqual(resolveRestoreModes(configuration.restore, true, true), {
    bazelisk: true,
    disk: false,
    repository: true,
  });
  assert.deepEqual(resolveSaveModes(configuration.save, true), {
    bazelisk: false,
    disk: false,
    repository: true,
  });
  assert.deepEqual(resolveRestoreModes({ ...configuration.restore, bazelisk: 'false' }, true, false), {
    bazelisk: false,
    disk: true,
    repository: true,
  });
  assert.throws(
    () => parseCacheConfiguration(raw({ bazeliskCacheRestore: 'auto' })),
    /Invalid bazelisk-cache-restore/
  );
});
