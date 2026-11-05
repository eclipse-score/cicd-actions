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
  cachePrefix,
  isOwnedGenerationKey,
  keyPlan,
} from '../src/cache-keys.js';
import { createConfiguration } from '../src/config.js';
import { externalRepositoryCache } from '../src/external.js';

test('cache families have explicit names', () => {
  const configuration = createConfiguration('/workspace', 'linux-debug');
  assert.equal(
    cachePrefix(configuration, configuration.caches.disk),
    `${configuration.baseKey}/${configuration.platform}/disk/key-linux-debug/`,
  );
  assert.equal(
    cachePrefix(configuration, configuration.caches.repository),
    `${configuration.baseKey}/${configuration.platform}/repository/`,
  );
});

test('disk cache family names cannot prefix-match another configuration', async (context) => {
  context.mock.method(Date, 'now', () => 1700000000000);

  const build = createConfiguration('/workspace', 'build');
  const buildQnx = createConfiguration('/workspace', 'build.qnx_x86_64');
  const buildPlan = await keyPlan(build, build.caches.disk);
  const buildQnxPlan = await keyPlan(buildQnx, buildQnx.caches.disk);

  assert.equal(
    buildPlan.key,
    `${build.baseKey}/${build.platform}/disk/key-build/generation-1700000000000`,
  );
  assert.equal(
    buildQnxPlan.key,
    `${buildQnx.baseKey}/${buildQnx.platform}/disk/key-build.qnx_x86_64/generation-1700000000000`,
  );
  assert.equal(buildQnxPlan.key.startsWith(buildPlan.restoreKeys[0]), false);
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
    new RegExp(`^${configuration.baseKey}/${configuration.platform}/bazelisk/version-8\\.6\\.0$`),
  );
  assert.deepEqual(plan.restoreKeys, []);
});

test('repository cache uses one rolling generation family for all configurations', async (context) => {
  let timestamp = 1700000000000;
  context.mock.method(Date, 'now', () => timestamp);

  const configuration = createConfiguration('/workspace', 'test');
  const prefix = cachePrefix(configuration, configuration.caches.repository);
  const first = await keyPlan(configuration, configuration.caches.repository);
  assert.equal(first.key, `${prefix}generation-${timestamp}`);
  assert.deepEqual(first.restoreKeys, [`${prefix}generation-`, prefix]);

  timestamp += 1;
  const second = await keyPlan(configuration, configuration.caches.repository);
  assert.equal(second.key, `${prefix}generation-${timestamp}`);
  assert.deepEqual(second.restoreKeys, [`${prefix}generation-`, prefix]);
});

test('manifest generations use the same readable family format', async (context) => {
  context.mock.method(Date, 'now', () => 1700000000000);

  const configuration = createConfiguration('/workspace', 'build', {
    externalCacheEnabled: true,
  });
  configuration.caches.externalManifest = configuration.external.manifest;
  const manifest = await keyPlan(configuration, configuration.caches.externalManifest);

  assert.equal(
    manifest.key,
    `${configuration.baseKey}/${configuration.platform}/external-manifest/generation-1700000000000`,
  );
  assert.deepEqual(
    manifest.restoreKeys,
    [
      `${configuration.baseKey}/${configuration.platform}/external-manifest/generation-`,
      `${configuration.baseKey}/${configuration.platform}/external-manifest/`,
    ],
  );
});

test('only setup-bazel-cache generation keys are eligible for cleanup', () => {
  const configuration = createConfiguration('/workspace', 'test');
  const repositoryPrefix = cachePrefix(configuration, configuration.caches.repository);
  const diskPrefix = cachePrefix(configuration, configuration.caches.disk);

  assert.equal(
    isOwnedGenerationKey(configuration, configuration.caches.repository, `${repositoryPrefix}generation-1700000000000`),
    true,
  );
  assert.equal(
    isOwnedGenerationKey(configuration, configuration.caches.disk, `${diskPrefix}generation-1700000000000`),
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

test('root and nested disk/manifest generations never cross-restore or cross-clean', async (context) => {
  context.mock.method(Date, 'now', () => 1700000000000);
  const configurations = ['.', 'examples/integration', 'examples/other'].map((directory) =>
    createConfiguration(`/checkout/${directory}`, 'same-job', {
      workspaceDirectory: directory,
      externalCacheEnabled: true,
    }));
  for (const family of ['disk', 'external-manifest']) {
    const caches = configurations.map((configuration) => family === 'disk'
      ? configuration.caches.disk : configuration.external.manifest);
    const plans = await Promise.all(configurations.map((configuration, index) =>
      keyPlan(configuration, caches[index])));
    for (let index = 0; index < configurations.length; index += 1) {
      for (let other = 0; other < configurations.length; other += 1) {
        if (index === other) continue;
        // Check every fallback, not just the exact key. A broad root-family
        // fallback must not restore a nested module or claim it during cleanup.
        assert.equal(plans[index].restoreKeys.some((prefix) => plans[other].key.startsWith(prefix)), false);
        assert.equal(isOwnedGenerationKey(configurations[index], caches[index], plans[other].key), false);
      }
    }
  }
});

test('workspace namespace is stable across runners and bounded for long disk keys', async (context) => {
  context.mock.method(Date, 'now', () => 1700000000000);
  const directory = `examples/${'long-module-name/'.repeat(20)}integration`;
  const first = createConfiguration('/runner-one/checkout', 'a'.repeat(400), { workspaceDirectory: directory });
  const relocated = createConfiguration('/another/runner/checkout', 'a'.repeat(400), { workspaceDirectory: directory });
  const plan = await keyPlan(first, first.caches.disk);
  const other = await keyPlan(relocated, relocated.caches.disk);
  assert.equal(plan.key, other.key);
  assert.ok(plan.key.length <= 512);
  assert.ok(plan.restoreKeys.every((key) => key.length <= 512));
});


test('nested workspaces still share Bazel downloads and identical extracted repositories', async (context) => {
  context.mock.method(Date, 'now', () => 1700000000000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bazel shared payloads-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested);
  for (const directory of [root, nested]) {
    fs.writeFileSync(path.join(directory, '.bazelversion'), '8.8.2\n');
    fs.writeFileSync(path.join(directory, 'MODULE.bazel.lock'), '{}\n');
  }
  const configurations = [root, nested].map((directory, index) =>
    createConfiguration(directory, 'build', {
      workspaceDirectory: index === 0 ? '.' : 'nested',
      externalCacheEnabled: true,
      outputBase: path.join(directory, 'output-base'),
    }));
  for (const family of ['bazelisk', 'repository']) {
    const plans = await Promise.all(configurations.map((configuration) =>
      keyPlan(configuration, configuration.caches[family])));
    assert.deepEqual(plans[0], plans[1]);
  }
  const repositories = await Promise.all(configurations.map((configuration) =>
    keyPlan(configuration, externalRepositoryCache(configuration, 'rules_cc'))));
  assert.deepEqual(repositories[0], repositories[1]);
});
