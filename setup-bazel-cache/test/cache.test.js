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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  canSaveAfterFailure,
  deleteCacheByKey,
  repositoryCacheGrewByTenPercent,
  restoredKeyState,
  restoreOutput,
  RESTORE_RESULT,
  shouldSave,
  shouldSaveRepositoryCache,
  skippedSaveSummary,
} from '../src/cache.js';
import { cacheLabel, cachePrefix } from '../src/cache-keys.js';
import { createConfiguration } from '../src/config.js';

test('restore results use a stable output vocabulary', () => {
  assert.deepEqual(RESTORE_RESULT, {
    FALSE: 'false',
    PARTIAL: 'partial',
    SKIPPED: 'skipped',
    TRUE: 'true',
    UNKNOWN: 'unknown',
  });
});

test('restore outputs expose successful restores as true', () => {
  assert.equal(restoreOutput(RESTORE_RESULT.TRUE), 'true');
  assert.equal(restoreOutput(RESTORE_RESULT.PARTIAL), 'true');
  assert.equal(restoreOutput(RESTORE_RESULT.FALSE), 'false');
  assert.equal(restoreOutput(RESTORE_RESULT.SKIPPED), 'false');
  assert.equal(restoreOutput(RESTORE_RESULT.UNKNOWN), 'false');
});

test('skipped save summaries include before and after local sizes', (context) => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), 'setup-bazel-cache-summary-test-'),
  );
  context.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'payload'), 'payload');
  const configuration = createConfiguration('/workspace', 'linux-debug');
  const cacheConfiguration = { name: 'disk', path: workspace };

  assert.deepEqual(
    skippedSaveSummary(configuration, cacheConfiguration, 'disabled'),
    {
      cache: cacheLabel(configuration, cacheConfiguration),
      sizeBefore: 7,
      sizeAfter: 7,
      uploaded: false,
      status: 'disabled',
    },
  );
});

test('failed jobs may save standard caches only when every selected restore was additive', () => {
  const additive = {
    bazelisk: RESTORE_RESULT.TRUE,
    disk: RESTORE_RESULT.PARTIAL,
    repository: RESTORE_RESULT.PARTIAL,
  };
  assert.equal(canSaveAfterFailure(additive, { bazelisk: true, disk: true, repository: true }), true);

  assert.equal(
    canSaveAfterFailure({ ...additive, disk: RESTORE_RESULT.FALSE }, { bazelisk: true, disk: true, repository: true }),
    false,
  );
  assert.equal(
    canSaveAfterFailure({ ...additive, disk: RESTORE_RESULT.SKIPPED }, { bazelisk: true, disk: true, repository: true }),
    false,
  );
  assert.equal(
    canSaveAfterFailure({ ...additive, disk: RESTORE_RESULT.UNKNOWN }, { bazelisk: true, disk: true, repository: true }),
    false,
  );
  assert.equal(
    canSaveAfterFailure(
      { ...additive, bazelisk: RESTORE_RESULT.PARTIAL },
      { bazelisk: true, disk: true, repository: true },
    ),
    false,
  );
  assert.equal(canSaveAfterFailure({ ...additive, repository: RESTORE_RESULT.FALSE }, {
    bazelisk: true,
    disk: true,
    repository: false,
  }), true);
  assert.equal(canSaveAfterFailure({ ...additive, disk: RESTORE_RESULT.FALSE }, {
    bazelisk: true,
    disk: false,
    repository: true,
  }), true);
  assert.equal(canSaveAfterFailure({ ...additive, bazelisk: RESTORE_RESULT.FALSE }, {
    bazelisk: false,
    disk: true,
    repository: true,
  }), true);
  assert.equal(canSaveAfterFailure(additive, {
    bazelisk: false,
    disk: false,
    repository: false,
  }), false);
  assert.equal(canSaveAfterFailure({ ...additive, external: RESTORE_RESULT.PARTIAL }, {
    bazelisk: false,
    disk: false,
    external: true,
    repository: false,
  }), false);
});

test('failed generational restores do not replace the existing cache snapshot', () => {
  const configuration = createConfiguration('/workspace', 'test');

  assert.equal(shouldSave(configuration.caches.disk, RESTORE_RESULT.UNKNOWN), false);
  assert.equal(shouldSave(configuration.caches.repository, RESTORE_RESULT.UNKNOWN), false);
  assert.equal(shouldSave(configuration.caches.disk, RESTORE_RESULT.FALSE), true);
  assert.equal(shouldSave(configuration.caches.disk, RESTORE_RESULT.PARTIAL), true);
  assert.equal(shouldSave(configuration.caches.bazelisk, RESTORE_RESULT.UNKNOWN), true);
});

test('repository cache auto mode still seeds a missing cache', () => {
  assert.equal(shouldSaveRepositoryCache('auto', RESTORE_RESULT.FALSE), true);
  assert.equal(shouldSaveRepositoryCache('auto', RESTORE_RESULT.TRUE), false);
  assert.equal(shouldSaveRepositoryCache('auto', RESTORE_RESULT.PARTIAL), false);
  assert.equal(shouldSaveRepositoryCache('auto', RESTORE_RESULT.UNKNOWN), false);
  assert.equal(shouldSaveRepositoryCache('auto', RESTORE_RESULT.SKIPPED), false);
  assert.equal(shouldSaveRepositoryCache('true', RESTORE_RESULT.TRUE), true);
  assert.equal(shouldSaveRepositoryCache('false', RESTORE_RESULT.FALSE), false);
});

test('repository cache auto mode publishes after ten percent growth', () => {
  assert.equal(repositoryCacheGrewByTenPercent(100, 110), true);
  assert.equal(repositoryCacheGrewByTenPercent(100, 109), false);
  assert.equal(repositoryCacheGrewByTenPercent(0, 1), true);
  assert.equal(repositoryCacheGrewByTenPercent(null, 100), false);

  assert.equal(
    shouldSaveRepositoryCache('auto', RESTORE_RESULT.PARTIAL, 100, 110),
    true,
  );
  assert.equal(
    shouldSaveRepositoryCache('auto', RESTORE_RESULT.PARTIAL, 100, 109),
    false,
  );
  assert.equal(
    shouldSaveRepositoryCache('auto', RESTORE_RESULT.UNKNOWN, 100, 200),
    false,
  );
});

test('restored cache keys use a stable post-action state name', () => {
  assert.equal(
    restoredKeyState({ name: 'repository' }),
    'setup-bazel-cache-restored-key-repository',
  );
});

test('previous cache cleanup preserves a GitHub Enterprise Server API base path', async (context) => {
  let request;
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url: String(url), options };
    return { ok: true, status: 200, statusText: 'OK' };
  });

  const configuration = createConfiguration('/workspace', 'test');
  const cacheConfiguration = configuration.caches.repository;
  const oldKey = `${cachePrefix(configuration, cacheConfiguration)}generation-1700000000000`;
  assert.equal(await deleteCacheByKey(oldKey, {
    configuration,
    cacheConfiguration,
    token: 'token',
    apiUrl: 'https://ghes.example.test/api/v3',
    repository: 'owner/repository',
    ref: 'refs/heads/main',
  }), true);
  assert.equal(
    request.url,
    `https://ghes.example.test/api/v3/repos/owner/repository/actions/caches?key=${encodeURIComponent(oldKey)}&ref=refs%2Fheads%2Fmain`,
  );
});

test('previous cache cleanup uses the current ref and exact cache family', async (context) => {
  let request;
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url: String(url), options };
    return { ok: true, status: 200, statusText: 'OK' };
  });

  const configuration = createConfiguration('/workspace', 'test');
  const cacheConfiguration = configuration.caches.repository;
  const oldKey = `${cachePrefix(configuration, cacheConfiguration)}generation-1700000000000`;
  assert.equal(await deleteCacheByKey(oldKey, {
    configuration,
    cacheConfiguration,
    token: 'token',
    apiUrl: 'https://api.example.test',
    repository: 'owner/repository',
    ref: 'refs/heads/main',
  }), true);
  assert.equal(
    request.url,
    `https://api.example.test/repos/owner/repository/actions/caches?key=${encodeURIComponent(oldKey)}&ref=refs%2Fheads%2Fmain`,
  );
  assert.equal(request.options.method, 'DELETE');
});

test('foreign cache keys are never sent to the delete API', async (context) => {
  let requestCount = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    requestCount += 1;
    return { ok: true, status: 200, statusText: 'OK' };
  });

  const configuration = createConfiguration('/workspace', 'test');
  assert.equal(await deleteCacheByKey('foreign-cache-1700000000000', {
    configuration,
    cacheConfiguration: configuration.caches.repository,
    token: 'token',
    apiUrl: 'https://api.example.test',
    repository: 'owner/repository',
    ref: 'refs/heads/main',
  }), false);
  assert.equal(requestCount, 0);
});

test('insufficient cache cleanup permission is non-fatal', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => ({
    ok: false,
    status: 403,
    statusText: 'Forbidden',
  }));

  const configuration = createConfiguration('/workspace', 'test');
  const cacheConfiguration = configuration.caches.disk;
  const oldKey = `${cachePrefix(configuration, cacheConfiguration)}generation-1700000000000`;
  await assert.doesNotReject(() => deleteCacheByKey(oldKey, {
    configuration,
    cacheConfiguration,
    token: 'token',
    apiUrl: 'https://api.example.test',
    repository: 'owner/repository',
    ref: 'refs/heads/main',
  }));
});

test('repository auto mode does not allow failed jobs to seed a cache', () => {
  const restored = {
    bazelisk: RESTORE_RESULT.TRUE,
    disk: RESTORE_RESULT.PARTIAL,
    repository: RESTORE_RESULT.FALSE,
  };
  assert.equal(canSaveAfterFailure(restored, {
    bazelisk: true,
    disk: true,
    repository: true,
  }), false);
  assert.equal(canSaveAfterFailure({ ...restored, repository: RESTORE_RESULT.PARTIAL }, {
    bazelisk: true,
    disk: true,
    repository: true,
  }), true);
});

test('cache cleanup is skipped without failing when required context is missing', async (context) => {
  let requestCount = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    requestCount += 1;
    return { ok: true, status: 200, statusText: 'OK' };
  });

  const configuration = createConfiguration('/workspace', 'test');
  const cacheConfiguration = configuration.caches.repository;
  const oldKey = `${cachePrefix(configuration, cacheConfiguration)}generation-1700000000000`;
  const base = {
    configuration,
    cacheConfiguration,
    token: 'token',
    apiUrl: 'https://api.example.test',
    repository: 'owner/repository',
    ref: 'refs/heads/main',
  };

  // Use '' rather than undefined: undefined would fall through to
  // deleteCacheByKey's own defaults (core.getInput('token'),
  // process.env.GITHUB_REPOSITORY/GITHUB_REF), which are genuinely set on a
  // real GitHub Actions runner and would silently make this test pass for
  // the wrong reason (or fail, since CI does have those values).
  assert.equal(await deleteCacheByKey(oldKey, { ...base, token: '' }), false);
  assert.equal(await deleteCacheByKey(oldKey, { ...base, repository: '' }), false);
  assert.equal(await deleteCacheByKey(oldKey, { ...base, ref: '' }), false);
  assert.equal(await deleteCacheByKey(oldKey, { ...base, repository: 'not-a-repository-slug' }), false);
  assert.equal(await deleteCacheByKey(oldKey, { ...base, repository: 'owner/repo/extra' }), false);
  assert.equal(requestCount, 0);
});
