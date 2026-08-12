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
  parseRestoreConfiguration,
  resolveRestoreConfiguration,
} from '../src/inputs.js';

/** Supply every optional raw input so individual tests only override relevant values. */
function raw(overrides = {}) {
  return {
    skipCacheRestore: '',
    skipDiskCacheRestore: '',
    skipRepositoryCacheRestore: '',
    ...overrides,
  };
}

test('only the configured main branch can save caches', () => {
  assert.equal(isCacheSaveRef('refs/heads/main', 'main'), true);
  assert.equal(isCacheSaveRef('refs/heads/feature', 'main'), false);
  assert.equal(isCacheSaveRef('refs/pull/123/merge', 'main'), false);
  assert.equal(isCacheSaveRef('refs/heads/trunk', 'trunk'), true);
});

test('new API has auto disk and restoring repository defaults', () => {
  const configuration = parseRestoreConfiguration(raw());
  assert.deepEqual(configuration, {
    legacy: false,
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

test('legacy true retains the global restore behavior', () => {
  const configuration = parseRestoreConfiguration(raw({ skipCacheRestore: 'true' }));
  assert.equal(configuration.legacy, true);
  assert.deepEqual(resolveRestoreConfiguration(configuration, true, false), {
    skipBazelisk: true,
    skipDisk: true,
    skipRepository: true,
  });
});

test('legacy auto applies one lock-file decision to every cache', () => {
  const configuration = parseRestoreConfiguration(raw({ skipCacheRestore: 'auto' }));
  assert.equal(needsLockFileCheck(configuration, true), true);
  assert.deepEqual(resolveRestoreConfiguration(configuration, true, true), {
    skipBazelisk: true,
    skipDisk: true,
    skipRepository: true,
  });
});

test('legacy and new APIs cannot be mixed', () => {
  assert.throws(
    () => parseRestoreConfiguration(raw({ skipCacheRestore: 'false', skipDiskCacheRestore: 'false' })),
    /cannot be combined/
  );
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
