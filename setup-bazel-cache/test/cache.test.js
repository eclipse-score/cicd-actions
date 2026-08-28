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
  cacheLabel,
  cachePrefix,
  canSaveAfterFailure,
  describeLocalCachePath,
  deleteCacheByKey,
  keyPlan,
  RESTORE_RESULT,
  formatBytes,
  isOwnedGenerationKey,
  localPathSize,
  repositoryCacheGrewByTenPercent,
  restoreOutput,
  restoredKeyState,
  skippedSaveSummary,
  shouldSaveRepositoryCache,
  shouldSave,
} from '../src/cache.js';
import { createConfiguration } from '../src/config.js';

test('cache families have explicit names', () => {
  const configuration = createConfiguration('/workspace', 'linux-debug');
  assert.equal(
    cachePrefix(configuration, configuration.caches.disk),
    `${configuration.baseKey}-disk-11-linux-debug-`
  );
  assert.equal(
    cachePrefix(configuration, configuration.caches.repository),
    `${configuration.baseKey}-repository-`
  );
});

test('disk cache family names cannot prefix-match another configuration', async (context) => {
  context.mock.method(Date, 'now', () => 1700000000000);

  const build = createConfiguration('/workspace', 'build');
  const buildRelease = createConfiguration('/workspace', 'build-release');
  const buildPlan = await keyPlan(build, build.caches.disk);
  const buildReleasePlan = await keyPlan(buildRelease, buildRelease.caches.disk);

  assert.equal(buildReleasePlan.key.startsWith(buildPlan.restoreKeys[0]), false);
});

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

test('local cache sizes are formatted compactly and ignore symlinks', (context) => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), 'setup-bazel-cache-size-test-'),
  );
  context.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  fs.writeFileSync(path.join(workspace, 'small'), '123');
  fs.mkdirSync(path.join(workspace, 'nested'));
  fs.writeFileSync(path.join(workspace, 'nested', 'large'), 'x'.repeat(1024));
  fs.symlinkSync(path.join(workspace, 'small'), path.join(workspace, 'ignored-link'));

  assert.equal(localPathSize(workspace), 1027);
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.00 KiB');
  assert.equal(formatBytes(1024 * 1024), '1.00 MiB');
});

test('empty cache diagnostics distinguish missing and empty paths', (context) => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), 'setup-bazel-cache-empty-diagnostics-'),
  );
  context.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const empty = path.join(workspace, 'empty');
  const missing = path.join(workspace, 'missing');
  fs.mkdirSync(empty);

  assert.equal(describeLocalCachePath(empty), `${empty}: empty directory`);
  assert.equal(describeLocalCachePath(missing), `${missing}: missing`);
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

test('failed jobs may save only when every selected cache restore was additive', () => {
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
});

test('content-based cache keys do not restore snapshots for other content', async (context) => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), 'setup-bazel-cache-test-'),
  );
  context.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, '.bazelversion'), '8.6.0\n');

  const configuration = createConfiguration(workspace, 'test');
  const plan = await keyPlan(configuration, configuration.caches.bazelisk);
  assert.match(
    plan.key,
    new RegExp(`^${configuration.baseKey}-bazelisk-8\\.6\\.0$`),
  );
  assert.deepEqual(plan.restoreKeys, []);
});

test('repository cache uses one rolling generation family for all configurations', async (context) => {
  let timestamp = 1700000000000;
  context.mock.method(Date, 'now', () => timestamp);

  const configuration = createConfiguration('/workspace', 'test');
  const prefix = cachePrefix(configuration, configuration.caches.repository);
  const first = await keyPlan(configuration, configuration.caches.repository);
  assert.equal(first.key, `${prefix}${timestamp}`);
  assert.equal(first.key.replace(/-[0-9a-f]{8,64}$/, ''), prefix.slice(0, -1));
  assert.deepEqual(first.restoreKeys, [prefix]);

  timestamp += 1;
  const second = await keyPlan(configuration, configuration.caches.repository);
  assert.equal(second.key, `${prefix}${timestamp}`);
  assert.deepEqual(second.restoreKeys, [prefix]);
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

test('only setup-bazel-cache generation keys are eligible for cleanup', () => {
  const configuration = createConfiguration('/workspace', 'test');
  const repositoryPrefix = cachePrefix(configuration, configuration.caches.repository);
  const diskPrefix = cachePrefix(configuration, configuration.caches.disk);

  assert.equal(
    isOwnedGenerationKey(configuration, configuration.caches.repository, `${repositoryPrefix}1700000000000`),
    true,
  );
  assert.equal(
    isOwnedGenerationKey(configuration, configuration.caches.disk, `${diskPrefix}1700000000000`),
    true,
  );
  assert.equal(
    isOwnedGenerationKey(configuration, configuration.caches.repository, 'unrelated-cache-1700000000000'),
    false,
  );
  assert.equal(
    isOwnedGenerationKey(configuration, configuration.caches.repository, `${repositoryPrefix}not-a-generation`),
    false,
  );
  assert.equal(
    isOwnedGenerationKey(configuration, configuration.caches.bazelisk, `${configuration.baseKey}-bazelisk-1700000000000`),
    false,
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
  const oldKey = `${cachePrefix(configuration, cacheConfiguration)}1700000000000`;
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
    `https://api.example.test/repos/owner/repository/actions/caches?key=${oldKey}&ref=refs%2Fheads%2Fmain`,
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
  const oldKey = `${cachePrefix(configuration, cacheConfiguration)}1700000000000`;
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
