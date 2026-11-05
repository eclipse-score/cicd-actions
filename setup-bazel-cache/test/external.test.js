// *******************************************************************************
// Copyright (c) 2026 Contributors to the Eclipse Foundation
//
// See the NOTICE file(s) distributed with this work for additional
// information regarding copyright ownership.
//
// This program and the accompanying materials are made available under the
// terms of the Apache License 2.0 which is available at
// https://www.apache.org/licenses/LICENSE-2.0
//
// SPDX-License-Identifier: Apache-2.0
// *******************************************************************************

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConfiguration } from '../src/config.js';
import {
  aggregateRestoreResult,
  configureExternalCache,
  discoverExternalRepositories,
  EXTERNAL_CACHE_MIN_SIZE,
  externalRepositoryCache,
  readExternalManifest,
  restoreExternalCaches,
  saveExternalCaches,
  validateExternalRepositoryName,
} from '../src/external.js';
import { RESTORE_RESULT } from '../src/cache.js';
// Exercise the same path versioning and tar implementation used by the cache
// service, while replacing only the network transfer with a local archive map.
import { getCacheVersion, resolvePaths } from '../node_modules/@actions/cache/lib/internal/cacheUtils.js';
import { createTar, extractTar } from '../node_modules/@actions/cache/lib/internal/tar.js';
import { cachePaths } from '../src/cache-size.js';
import { keyPlan } from '../src/cache-keys.js';

test('external cache configuration points at Bazel output_base external', () => {
  const configuration = createConfiguration('/workspace', 'test', {
    externalCacheEnabled: true,
    outputBase: '/tmp/bazel-output-base',
  });
  configureExternalCache(configuration, '/tmp/bazel-output-base');

  assert.equal(configuration.external.root, '/tmp/bazel-output-base/external');
  assert.equal(configuration.caches.externalManifest, configuration.external.manifest);
  assert.equal(configuration.external.minSize, EXTERNAL_CACHE_MIN_SIZE);
});

test('external repository cache uses an immutable identity key', () => {
  const configuration = createConfiguration('/workspace', 'test', {
    externalCacheEnabled: true,
    outputBase: '/tmp/bazel-output-base',
  });
  configureExternalCache(configuration, '/tmp/bazel-output-base');

  assert.deepEqual(externalRepositoryCache(configuration, 'rules_cc'), {
    files: configuration.external.identityFiles,
    generational: false,
    keyComponents: ['rules_cc'],
    name: 'external',
    paths: [
      path.join(configuration.external.stagingRoot, 'rules_cc', '@rules_cc.marker'),
      path.join(configuration.external.stagingRoot, 'rules_cc', 'rules_cc'),
    ],
  });
});

test('external cache names cannot escape the output external directory', () => {
  assert.equal(validateExternalRepositoryName('rules_cc~override'), 'rules_cc~override');
  assert.equal(validateExternalRepositoryName('rules.cc'), 'rules.cc');
  assert.equal(
    validateExternalRepositoryName('rules_python++config+pypi__build'),
    'rules_python++config+pypi__build',
  );
  assert.throws(() => validateExternalRepositoryName('../outside'), /Invalid external repository/);
  assert.throws(() => validateExternalRepositoryName('repo/name'), /Invalid external repository/);
  assert.throws(() => validateExternalRepositoryName('repo\nname'), /Invalid external repository/);
});

test('external discovery includes directories and ignores marker files and symlinks', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-bazel-cache-external-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'rules_cc'));
  fs.mkdirSync(path.join(root, 'rules_python++config+pypi__build'));
  fs.writeFileSync(path.join(root, '@rules_cc.marker'), 'marker');
  fs.mkdirSync(path.join(root, 'local_repo'));
  fs.rmSync(path.join(root, 'local_repo'), { recursive: true, force: true });
  fs.symlinkSync(path.join(root, 'rules_cc'), path.join(root, 'local_repo'));

  assert.deepEqual(
    discoverExternalRepositories(root),
    ['rules_cc', 'rules_python++config+pypi__build'],
  );
});

test('external manifest accepts repository names but rejects path-like entries', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-bazel-cache-manifest-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = path.join(root, 'manifest.txt');
  fs.writeFileSync(manifest, 'rules_cc\n\nfoo~override\n');
  assert.deepEqual(readExternalManifest(manifest), ['rules_cc', 'foo~override']);

  fs.writeFileSync(manifest, '../outside\n');
  assert.throws(() => readExternalManifest(manifest), /Invalid external repository/);
});

test('external repository keys keep dots readable and do not fall back to a different dependency definition', async (context) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-bazel-cache-workspace-'));
  context.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'MODULE.bazel'), 'module(name = "test")\n');

  const configuration = createConfiguration(workspace, 'test', {
    externalCacheEnabled: true,
    outputBase: '/tmp/bazel-output-base',
  });
  configureExternalCache(configuration, '/tmp/bazel-output-base');
  const repository = externalRepositoryCache(configuration, 'rules.cc');
  const plan = await keyPlan(configuration, repository);

  assert.deepEqual(plan.restoreKeys, []);
  assert.match(
    plan.key,
    new RegExp(`^${configuration.baseKey}/${configuration.platform}/external/rules\\.cc/content-[0-9a-f]{16}$`),
  );
});

test('external repository names with and without dots have distinct complete prefixes', () => {
  const configuration = createConfiguration('/workspace', 'test', {
    externalCacheEnabled: true,
    outputBase: '/tmp/bazel-output-base',
  });
  configureExternalCache(configuration, '/tmp/bazel-output-base');

  const dotted = externalRepositoryCache(configuration, 'rules.cc');
  const underscored = externalRepositoryCache(configuration, 'rules_cc');
  assert.notEqual(dotted.keyComponents[0], underscored.keyComponents[0]);
  assert.equal(
    dotted.keyComponents[0],
    'rules.cc',
  );
  assert.equal(
    underscored.keyComponents[0],
    'rules_cc',
  );
});

test('aggregate external restore succeeds only when the manifest and every repository restore', () => {
  assert.equal(
    aggregateRestoreResult(RESTORE_RESULT.PARTIAL, {
      rules_cc: RESTORE_RESULT.PARTIAL,
      rules_java: RESTORE_RESULT.TRUE,
    }),
    RESTORE_RESULT.PARTIAL,
  );
  assert.equal(
    aggregateRestoreResult(RESTORE_RESULT.PARTIAL, {
      rules_cc: RESTORE_RESULT.FALSE,
    }),
    RESTORE_RESULT.FALSE,
  );
  assert.equal(
    aggregateRestoreResult(RESTORE_RESULT.UNKNOWN, {}),
    RESTORE_RESULT.UNKNOWN,
  );
});


/** Keep archive paths and process environment inside a disposable runner fixture. */
function archiveFixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bazel-external-archive-'));
  const workspace = path.join(root, 'checkout');
  fs.mkdirSync(workspace);
  const previousWorkspace = process.env.GITHUB_WORKSPACE;
  process.env.GITHUB_WORKSPACE = workspace;
  context.after(() => {
    if (previousWorkspace === undefined) delete process.env.GITHUB_WORKSPACE;
    else process.env.GITHUB_WORKSPACE = previousWorkspace;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const configurationFor = (directory) => {
    const module = path.join(workspace, directory);
    fs.mkdirSync(module, { recursive: true });
    fs.writeFileSync(path.join(module, '.bazelversion'), '8.8.2\n');
    fs.writeFileSync(path.join(module, 'MODULE.bazel.lock'), '{}\n');
    const outputBase = path.join(root, 'bazel', directory === '.' ? 'root' : directory);
    const configuration = createConfiguration(module, 'build', {
      workspaceDirectory: directory, externalCacheEnabled: true, outputBase,
    });
    configuration.external.stagingRoot = path.join(root, 'staging');
    configuration.external.manifest.path = path.join(root, 'manifest.txt');
    configuration.external.minSize = 0;
    configureExternalCache(configuration, outputBase);
    return configuration;
  };
  return { root, configurationFor };
}

test('real cache archives share repository payloads and restore them into the selected output base', async (context) => {
  const { root, configurationFor } = archiveFixture(context);
  const producer = configurationFor('.');
  const consumer = configurationFor('nested');
  const repository = path.join(producer.external.root, 'rules_cc');
  fs.mkdirSync(repository, { recursive: true });
  fs.writeFileSync(path.join(repository, 'compiler'), 'compiler payload', { mode: 0o755 });
  fs.symlinkSync('compiler', path.join(repository, 'compiler-link'));
  fs.writeFileSync(path.join(producer.external.root, '@rules_cc.marker'), 'Bazel marker');
  fs.mkdirSync(consumer.external.root, { recursive: true });
  fs.cpSync(producer.external.root, consumer.external.root, { recursive: true, verbatimSymlinks: true });

  const archives = new Map();
  let repositoryUploads = 0;
  const identity = async (configuration, cache) => {
    const plan = await keyPlan(configuration, cache);
    // Use the family prefix for generational manifest lookup, just as its
    // restore fallbacks do. Immutable payloads require the exact content key.
    return `${cache.generational ? plan.restoreKeys[0] : plan.key}:${getCacheVersion(cachePaths(cache), 'gzip')}`;
  };
  const saveArchive = async (configuration, cache) => {
    const key = await identity(configuration, cache);
    if (archives.has(key)) return { uploaded: false };
    const archive = path.join(root, `archive-${archives.size}`);
    fs.mkdirSync(archive);
    await createTar(archive, await resolvePaths(cachePaths(cache)), 'gzip');
    archives.set(key, path.join(archive, 'cache.tgz'));
    if (cache.name === 'external') repositoryUploads += 1;
    return { uploaded: true };
  };
  const restoreArchive = async (configuration, cache) => {
    const archive = archives.get(await identity(configuration, cache));
    if (!archive) return { result: RESTORE_RESULT.FALSE, sizeBefore: 0, sizeAfter: 0 };
    await extractTar(archive, 'gzip');
    return { result: RESTORE_RESULT.TRUE, sizeBefore: 0, sizeAfter: 1 };
  };

  // Both modules publish their own manifest, but identical dependency payloads
  // must have one complete identity (key AND cache version), not two uploads.
  for (const configuration of [producer, consumer]) {
    await saveExternalCaches(configuration, RESTORE_RESULT.FALSE, {}, async () => {}, saveArchive);
    assert.deepEqual(fs.readdirSync(configuration.external.stagingRoot), []);
  }
  assert.equal(repositoryUploads, 1);
  fs.rmSync(producer.external.root, { recursive: true });
  fs.rmSync(consumer.external.root, { recursive: true });
  fs.rmSync(consumer.external.manifest.path);

  for (const crossFilesystem of [false, true]) {
    fs.rmSync(consumer.external.root, { recursive: true, force: true });
    // The runner's temp directory may be on another mount than Bazel output.
    // Exercise that fallback without requiring a particular local disk layout.
    const rename = crossFilesystem ? context.mock.method(fs, 'renameSync', () => {
      throw Object.assign(new Error('cross-device move'), { code: 'EXDEV' });
    }) : null;
    const restored = await restoreExternalCaches(consumer, restoreArchive);
    assert.equal(restored.result, RESTORE_RESULT.TRUE);
    assert.equal(fs.readFileSync(path.join(consumer.external.root, 'rules_cc', 'compiler'), 'utf8'), 'compiler payload');
    assert.equal(fs.readlinkSync(path.join(consumer.external.root, 'rules_cc', 'compiler-link')), 'compiler');
    assert.equal(fs.statSync(path.join(consumer.external.root, 'rules_cc', 'compiler')).mode & 0o777, 0o755);
    assert.equal(fs.readFileSync(path.join(consumer.external.root, '@rules_cc.marker'), 'utf8'), 'Bazel marker');
    assert.equal(fs.existsSync(producer.external.root), false);
    assert.deepEqual(fs.readdirSync(consumer.external.stagingRoot), []);
    rename?.mock.restore();
  }
});

test('failed or missing archive transfers preserve existing output and clean staging', async (context) => {
  const { configurationFor } = archiveFixture(context);
  const configuration = configurationFor('nested');
  const repository = path.join(configuration.external.root, 'rules_cc');
  fs.mkdirSync(repository, { recursive: true });
  fs.writeFileSync(path.join(repository, 'existing'), 'keep this build output');

  for (const outcome of ['miss', 'error', 'incomplete']) {
    const detail = await restoreExternalCaches(configuration, async (_configuration, cache) => {
      if (cache.name === 'external-manifest') {
        fs.writeFileSync(cache.path, 'rules_cc\n');
        return { result: RESTORE_RESULT.TRUE, sizeBefore: 0, sizeAfter: 1 };
      }
      // A partial download must never be installed after a miss or exception.
      fs.writeFileSync(cache.paths[0], 'partial marker');
      if (outcome === 'error') throw new Error('simulated interrupted transfer');
      return { result: outcome === 'miss' ? RESTORE_RESULT.FALSE : RESTORE_RESULT.TRUE, sizeBefore: 0, sizeAfter: 1 };
    });
    assert.equal(detail.result, outcome === 'miss' ? RESTORE_RESULT.FALSE : RESTORE_RESULT.UNKNOWN);
    assert.equal(fs.readFileSync(path.join(repository, 'existing'), 'utf8'), 'keep this build output');
    assert.deepEqual(fs.readdirSync(configuration.external.stagingRoot), []);
  }

  await assert.rejects(saveExternalCaches(configuration, RESTORE_RESULT.FALSE, {}, async () => {}, async () => {
    throw new Error('simulated upload failure');
  }), /simulated upload failure/);
  assert.equal(fs.readFileSync(path.join(repository, 'existing'), 'utf8'), 'keep this build output');
  assert.deepEqual(fs.readdirSync(configuration.external.stagingRoot), []);
});
