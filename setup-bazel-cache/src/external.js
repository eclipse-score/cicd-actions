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
import { RESTORE_RESULT, restore, save, isExactCacheHit, skippedSaveSummary } from './cache.js';
import { cacheLabel } from './cache-keys.js';
import { localPathSize } from './cache-size.js';
import { formatCacheComponent } from './keys.js';

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
      { cause: error },
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
  const root = path.join(configuration.external.stagingRoot, name);
  const repositoryPath = path.join(root, name);
  const markerPath = path.join(root, `@${name}.marker`);
  return {
    files: configuration.external.identityFiles,
    generational: false,
    keyComponents: [formatCacheComponent(name, 'external repository name')],
    name: 'external',
    paths: [markerPath, repositoryPath],
  };
}

/**
 * Cache archives are staged at fixed runner-temp paths: GitHub hashes the paths
 * passed to its cache API as well as the content key. Archiving output_base
 * directly would make otherwise identical repositories workspace-specific.
 * Process one repository at a time and always remove its temporary payload.
 */
async function withExternalStaging(configuration, name, operation) {
  const cacheConfiguration = externalRepositoryCache(configuration, name);
  const directory = path.dirname(cacheConfiguration.paths[0]);
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  try {
    return await operation(cacheConfiguration, directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Copy the repository and its optional Bazel marker without changing the live
 * output tree. Reflinks avoid copying large file contents where supported;
 * other filesystems fall back to copying. Preserve relative symlinks verbatim
 * so moving through the archive directory does not rewrite repository contents.
 */
function stageExternalRepository(root, directory, name) {
  for (const entry of [name, `@${name}.marker`]) {
    const source = path.join(root, entry);
    if (!fs.existsSync(source)) continue;
    fs.cpSync(source, path.join(directory, entry), {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      mode: fs.constants.COPYFILE_FICLONE,
    });
  }
}

/**
 * Shared archives must not retain paths into the producer's output tree or
 * workspace. Accept relative symlinks contained in this repository; exclude
 * absolute links, dangling links and relative links escaping it. Walk directory
 * entries without traversing symlinks; resolve each link target separately to
 * catch escapes through intermediate directory symlinks as well.
 */
function findNonportableLink(repository) {
  const canonicalRoot = fs.realpathSync(repository);
  const pending = [repository];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      if (!entry.isSymbolicLink()) continue;
      const target = fs.readlinkSync(file);
      if (path.isAbsolute(target)) return path.relative(repository, file);
      let resolved;
      try {
        // Preserve '..' until native path resolution: normalizing it first can
        // hide an escape through a preceding directory symlink.
        resolved = fs.realpathSync.native(`${directory}${path.sep}${target}`);
      } catch (error) {
        if (!['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code)) throw error;
        return path.relative(repository, file);
      }
      const relative = path.relative(canonicalRoot, resolved);
      if (relative === '..' || relative.startsWith(`..${path.sep}`)) {
        return path.relative(repository, file);
      }
    }
  }
  return null;
}

/** Install a successfully restored payload into the selected Bazel output base. */
function installExternalRepository(directory, root, name) {
  // Validate before replacing anything: a missing or partial archive must not
  // discard an existing repository from a persistent runner's output tree.
  if (!fs.lstatSync(path.join(directory, name)).isDirectory()) {
    throw new Error(`Restored external repository '${name}' is not a directory.`);
  }
  const nonportable = findNonportableLink(path.join(directory, name));
  if (nonportable !== null) {
    throw new Error(`Restored external repository '${name}' has a nonportable symlink '${nonportable}'.`);
  }
  fs.mkdirSync(root, { recursive: true });
  // Invalidate BEFORE touching the repository. If a cross-filesystem copy runs
  // out of space, Bazel must not trust partial files under an old valid marker.
  // Publish the restored marker only after the whole directory is installed.
  const marker = path.join(root, `@${name}.marker`);
  fs.rmSync(marker, { force: true });
  try {
    for (const entry of [name, `@${name}.marker`]) {
      const source = path.join(directory, entry);
      const destination = path.join(root, entry);
      fs.rmSync(destination, { recursive: true, force: true });
      if (!fs.existsSync(source)) continue;
      try {
        fs.renameSync(source, destination);
      } catch (error) {
        // Runner temp and Bazel's output base can live on different filesystems.
        // Retain symlink text and permissions when a rename is unavailable.
        if (error.code !== 'EXDEV') throw error;
        fs.cpSync(source, destination, {
          recursive: true, preserveTimestamps: true, verbatimSymlinks: true,
        });
      }
    }
  } catch (error) {
    fs.rmSync(marker, { force: true });
    throw error;
  }
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
async function restoreExternalCaches(configuration, restoreCache = restore) {
  const manifest = configuration.caches.externalManifest;
  const manifestDetail = await restoreCache(configuration, manifest);
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
      try {
        repositoryDetails[name] = await withExternalStaging(configuration, name, async (cacheConfiguration, directory) => {
          const detail = await restoreCache(configuration, cacheConfiguration);
          if (detail.result === RESTORE_RESULT.TRUE || detail.result === RESTORE_RESULT.PARTIAL) {
            installExternalRepository(directory, configuration.external.root, name);
          }
          return detail;
        });
      } catch (error) {
        core.warning(`Could not install external cache '${name}': ${error.message}`);
        repositoryDetails[name] = { result: RESTORE_RESULT.UNKNOWN, sizeBefore: null, sizeAfter: null };
      }
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
  saveCache = save,
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

    const cacheConfiguration = externalRepositoryCache(configuration, name);
    if (isExactCacheHit(cacheConfiguration)) {
      // The immutable payload already exists. Report its live size without
      // copying hundreds of MiB just to discover that no upload is needed.
      eligibleNames.push(name);
      results.push(skippedSaveSummary(configuration, {
        ...cacheConfiguration,
        paths: [path.join(root, `@${name}.marker`), repositoryPath],
      }, 'exact cache hit'));
      continue;
    }

    const nonportable = findNonportableLink(repositoryPath);
    if (nonportable !== null) {
      core.info(`Skipping ${name} external cache because symlink '${nonportable}' is not portable between output directories`);
      continue;
    }

    eligibleNames.push(name);
    const result = await withExternalStaging(configuration, name, async (cacheConfiguration, directory) => {
      stageExternalRepository(root, directory, name);
      return saveCache(
        configuration,
        cacheConfiguration,
        repositoryRestoreResults[name] || RESTORE_RESULT.FALSE,
      );
    });
    results.push(result);
  }

  if (eligibleNames.length === 0) return results;

  fs.writeFileSync(
    configuration.external.manifest.path,
    `${eligibleNames.join('\n')}\n`,
  );
  const manifestResult = await saveCache(
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
