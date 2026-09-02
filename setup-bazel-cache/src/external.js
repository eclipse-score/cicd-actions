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

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as core from '@actions/core';
import {
  cacheLabel,
  localPathSize,
  RESTORE_RESULT,
  restore,
  save,
} from './cache.js';

const EXTERNAL_CACHE_MIN_SIZE = 500 * 1024 * 1024;
const MAX_EXTERNAL_REPOSITORY_NAME_LENGTH = 200;
const EXTERNAL_REPOSITORY_NAME = /^[A-Za-z0-9._~+@-]+$/u;

/** Resolve the output base Bazel will use for the current workspace. */
function resolveOutputBase(workspace) {
  let outputBase;
  try {
    outputBase = execFileSync(
      'bazel',
      ['info', 'output_base'],
      { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch (error) {
    throw new Error(
      `Could not resolve Bazel output_base: ${error.stderr?.trim() || error.message || error}`,
    );
  }

  if (!outputBase || !path.isAbsolute(outputBase)) {
    throw new Error(`Bazel returned an invalid output_base: '${outputBase}'.`);
  }

  // Do not modify the external tree while Bazel's server may still be running.
  try {
    execFileSync('bazel', ['shutdown'], {
      cwd: workspace,
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch (error) {
    core.warning(`Could not shut down Bazel after resolving output_base: ${error.message || error}`);
  }
  return outputBase;
}

/** Attach the resolved Bazel external directory to the action configuration. */
function configureExternalCache(configuration, outputBase) {
  if (!configuration.external) return;

  configuration.external.outputBase = outputBase;
  configuration.external.root = path.join(outputBase, 'external');
  configuration.caches.externalManifest = configuration.external.manifest;
}

/** Build the cache payload for one extracted external repository. */
function externalRepositoryCache(configuration, name) {
  validateExternalRepositoryName(name);
  const root = configuration.external.root;
  const repositoryPath = path.join(root, name);
  const markerPath = path.join(root, `@${name}.marker`);
  return {
    files: configuration.external.identityFiles,
    generational: false,
    name: `external-${name}`,
    paths: [markerPath, repositoryPath],
  };
}

/** Reject manifest names that could escape the Bazel external directory. */
function validateExternalRepositoryName(name) {
  if (
    typeof name !== 'string' ||
    !name ||
    name.length > MAX_EXTERNAL_REPOSITORY_NAME_LENGTH ||
    name === '.' ||
    name === '..' ||
    !EXTERNAL_REPOSITORY_NAME.test(name) ||
    [...name].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint < 32 || codePoint === 127;
    })
  ) {
    throw new Error(`Invalid external repository name '${name}'.`);
  }
  return name;
}

/** Read the action-owned manifest, ignoring blank lines and rejecting unsafe names. */
function readExternalManifest(manifestPath) {
  let contents;
  try {
    contents = fs.readFileSync(manifestPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  return contents
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean)
    .map(validateExternalRepositoryName);
}

/** Discover real directories in output_base/external; symlinked local repos are not portable. */
function discoverExternalRepositories(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        validateExternalRepositoryName(name);
        return true;
      } catch (error) {
        core.warning(`Skipping external repository '${name}': ${error.message || error}`);
        return false;
      }
    });
}

/** Return one result for the manifest and all repositories it names. */
function aggregateRestoreResult(manifestResult, repositoryResults) {
  if (manifestResult === RESTORE_RESULT.UNKNOWN) return RESTORE_RESULT.UNKNOWN;
  if (manifestResult === RESTORE_RESULT.FALSE) return RESTORE_RESULT.FALSE;
  const results = Object.values(repositoryResults);
  if (results.some((result) => result === RESTORE_RESULT.UNKNOWN)) {
    return RESTORE_RESULT.UNKNOWN;
  }
  if (results.some((result) => result !== RESTORE_RESULT.TRUE && result !== RESTORE_RESULT.PARTIAL)) {
    return RESTORE_RESULT.FALSE;
  }
  return manifestResult;
}

/** Sum restore sizes while preserving an unknown result from any component. */
function aggregateSize(manifestSize, repositoryDetails, field) {
  const sizes = [
    manifestSize,
    ...Object.values(repositoryDetails).map((detail) => detail[field]),
  ];
  return sizes.some((size) => size === null)
    ? null
    : sizes.reduce((total, size) => total + size, 0);
}

/** Restore the manifest and then the extracted repositories named by it. */
async function restoreExternalCaches(configuration) {
  const manifest = configuration.caches.externalManifest;
  const manifestDetail = await restore(configuration, manifest);
  const repositoryDetails = {};

  if (manifestDetail.result === RESTORE_RESULT.TRUE || manifestDetail.result === RESTORE_RESULT.PARTIAL) {
    let names;
    try {
      names = readExternalManifest(manifest.path);
    } catch (error) {
      core.warning(`Could not read external cache manifest: ${error.stack || error}`);
      return {
        manifest: manifestDetail,
        repositories: repositoryDetails,
        result: RESTORE_RESULT.UNKNOWN,
        sizeBefore: manifestDetail.sizeBefore,
        sizeAfter: manifestDetail.sizeAfter,
      };
    }

    for (const name of names) {
      const cacheConfiguration = externalRepositoryCache(configuration, name);
      repositoryDetails[name] = await restore(configuration, cacheConfiguration);
    }
  }

  const repositoryResults = Object.fromEntries(
    Object.entries(repositoryDetails).map(([name, detail]) => [name, detail.result]),
  );
  return {
    manifest: manifestDetail,
    repositories: repositoryDetails,
    result: aggregateRestoreResult(manifestDetail.result, repositoryResults),
    sizeBefore: aggregateSize(manifestDetail.sizeBefore, repositoryDetails, 'sizeBefore'),
    sizeAfter: aggregateSize(manifestDetail.sizeAfter, repositoryDetails, 'sizeAfter'),
  };
}

/** Save all sufficiently large extracted repositories and refresh their manifest. */
async function saveExternalCaches(
  configuration,
  manifestRestoreResult,
  repositoryRestoreResults,
  cleanupPreviousGeneration,
) {
  const root = configuration.external.root;
  const names = discoverExternalRepositories(root);
  const eligibleNames = [];
  const results = [];

  for (const name of names) {
    const repositoryPath = path.join(root, name);
    const size = localPathSize(repositoryPath);
    if (size < configuration.external.minSize) {
      core.info(
        `Skipping ${name} external cache because its extracted payload is ` +
        `${size} bytes, below the ${configuration.external.minSize}-byte threshold`,
      );
      continue;
    }

    eligibleNames.push(name);
    const cacheConfiguration = externalRepositoryCache(configuration, name);
    const result = await save(
      configuration,
      cacheConfiguration,
      repositoryRestoreResults[name] || RESTORE_RESULT.FALSE,
    );
    results.push(result);
  }

  if (eligibleNames.length === 0) return results;

  fs.writeFileSync(
    configuration.external.manifest.path,
    `${eligibleNames.join('\n')}\n`,
  );
  const manifestResult = await save(
    configuration,
    configuration.caches.externalManifest,
    manifestRestoreResult,
  );
  results.push(manifestResult);
  if (manifestResult.uploaded) {
    await cleanupPreviousGeneration(configuration, configuration.caches.externalManifest);
  }
  return results;
}

/** Describe the aggregate external cache using the same labels as other cache families. */
function externalCacheLabel(configuration) {
  return cacheLabel(configuration, {
    name: 'external',
  });
}

export {
  aggregateRestoreResult,
  configureExternalCache,
  discoverExternalRepositories,
  EXTERNAL_CACHE_MIN_SIZE,
  externalCacheLabel,
  externalRepositoryCache,
  readExternalManifest,
  resolveOutputBase,
  restoreExternalCaches,
  saveExternalCaches,
  validateExternalRepositoryName,
};
