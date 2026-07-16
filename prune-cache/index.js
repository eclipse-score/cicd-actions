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

'use strict';

/**
 * Keep only the newest cache generation for each cache family and Git ref.
 *
 * Cache keys must end in a hexadecimal hash preceded by "-" or "_".
 *
 * Examples:
 *
 *   bazel-linux-a1b2c3d4  -> family: bazel-linux
 *   bazel_linux_a1b2c3d4  -> family: bazel_linux
 *
 * Caches are grouped by both their Git ref and derived family:
 *
 *   refs/heads/main + bazel-linux
 *   refs/heads/release/1.0 + bazel-linux
 *
 * This prevents a cache from one branch or pull request from causing a cache
 * belonging to another ref to be deleted.
 *
 * Keys without a matching hash suffix are ignored.
 */

const HASH_SUFFIX = /[-_][0-9a-fA-F]{8,64}$/;
const PAGE_SIZE = 100;

async function main() {
  const token =
    process.env.INPUT_TOKEN ||
    process.env.GITHUB_TOKEN ||
    fail('Neither INPUT_TOKEN nor GITHUB_TOKEN is available.');

  const repository = requireEnvironmentVariable('GITHUB_REPOSITORY');
  const apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com';
  // GitHub maps the `dry-run` input to INPUT_DRY-RUN: it uppercases the name and
  // turns spaces into underscores, but keeps hyphens.
  const dryRun = parseBoolean(process.env['INPUT_DRY-RUN'] ?? 'false');

  const [owner, repo, ...unexpectedParts] = repository.split('/');

  if (!owner || !repo || unexpectedParts.length > 0) {
    throw new Error(
      `Invalid GITHUB_REPOSITORY value: "${repository}". ` +
        'Expected "owner/repository".',
    );
  }

  console.log(`Repository: ${repository}`);
  console.log(`Dry run:    ${dryRun}`);
  console.log('');

  const caches = await listCaches({
    apiUrl,
    token,
    owner,
    repo,
  });

  const { groups, skipped } = groupCaches(caches);

  console.log(`Found ${caches.length} cache(s).`);
  console.log(`Found ${groups.size} cache group(s).`);
  console.log(`Skipped ${skipped.length} cache(s) that could not be grouped.`);
  console.log('');

  const obsoleteCaches = findObsoleteCaches(groups);

  if (obsoleteCaches.length === 0) {
    console.log('No obsolete cache generations found.');
    return;
  }

  const totalSize = obsoleteCaches.reduce(
    (sum, cache) => sum + cache.size_in_bytes,
    0,
  );

  console.log(
    `${dryRun ? 'Would delete' : 'Deleting'} ` +
      `${obsoleteCaches.length} obsolete cache generation(s) ` +
      `totalling ${formatBytes(totalSize)}:`,
  );
  console.log('');

  let deletedCount = 0;
  let deletedSize = 0;
  const failures = [];

  for (const cache of obsoleteCaches) {
    console.log(`${dryRun ? 'Would delete' : 'Deleting'}: ${cache.key}`);
    console.log(`  Ref:     ${cache.ref}`);
    console.log(`  Family:  ${cache.family}`);
    console.log(`  Created: ${cache.created_at}`);
    console.log(`  Size:    ${formatBytes(cache.size_in_bytes)}`);

    if (!dryRun) {
      // Keep going after a failed deletion so a single transient error does
      // not strand the remaining obsolete caches. Failures are reported and
      // turned into a non-zero exit code at the end.
      try {
        await deleteCache({
          apiUrl,
          token,
          owner,
          repo,
          cacheId: cache.id,
        });

        deletedCount += 1;
        deletedSize += cache.size_in_bytes;
      } catch (error) {
        console.log(`  Failed:  ${error.message}`);
        failures.push({ cache, error });
      }
    }

    console.log('');
  }

  if (dryRun) {
    console.log(
      `Dry run complete. ${obsoleteCaches.length} cache generation(s) ` +
        `totalling ${formatBytes(totalSize)} would be deleted.`,
    );
    return;
  }

  console.log(
    `Deleted ${deletedCount} cache generation(s), ` +
      `freeing ${formatBytes(deletedSize)}.`,
  );

  if (failures.length > 0) {
    throw new Error(
      `Failed to delete ${failures.length} of ${obsoleteCaches.length} ` +
        'obsolete cache generation(s).',
    );
  }
}

/**
 * Fetch all completed caches in the repository.
 *
 * GitHub returns at most 100 entries per page. Pagination ends when a page
 * contains fewer than PAGE_SIZE entries.
 */
async function listCaches({ apiUrl, token, owner, repo }) {
  const caches = [];

  for (let page = 1; ; page += 1) {
    const url = new URL(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
        '/actions/caches',
      apiUrl,
    );

    url.searchParams.set('per_page', String(PAGE_SIZE));
    url.searchParams.set('page', String(page));

    const response = await githubRequest(url, {
      token,
      method: 'GET',
    });

    const body = await response.json();
    const pageCaches = body.actions_caches;

    if (!Array.isArray(pageCaches)) {
      throw new Error('GitHub returned an invalid cache list response.');
    }

    caches.push(...pageCaches);

    if (pageCaches.length < PAGE_SIZE) {
      return caches;
    }
  }
}

/**
 * Group caches by Git ref and logical cache family.
 *
 * Only the final "-hash" or "_hash" part is removed. Everything before it is
 * considered the cache family.
 *
 * Examples:
 *
 *   refs/heads/main:
 *     bazel-linux-11111111
 *     bazel-linux-22222222
 *
 *   Both belong to:
 *     ref:    refs/heads/main
 *     family: bazel-linux
 *
 * A similarly named cache on another ref belongs to a different group.
 */
function groupCaches(caches) {
  const groups = new Map();
  const skipped = [];

  for (const cache of caches) {
    if (!HASH_SUFFIX.test(cache.key)) {
      skipped.push(cache);
      continue;
    }

    const family = cache.key.replace(HASH_SUFFIX, '');

    // Avoid treating malformed keys such as "_deadbeef" as valid.
    if (family.length === 0) {
      skipped.push(cache);
      continue;
    }

    if (!cache.ref) {
      skipped.push(cache);
      continue;
    }

    /*
     * The NUL character separates the ref and family unambiguously. A normal
     * separator such as ":" or "/" could theoretically occur in either value
     * and cause two unrelated groups to produce the same key.
     */
    const groupKey = `${cache.ref}\0${family}`;
    const groupCaches = groups.get(groupKey) || [];

    groupCaches.push({
      ...cache,
      family,
    });

    groups.set(groupKey, groupCaches);
  }

  return { groups, skipped };
}

/**
 * Keep the newest entry from every ref/family group and return all older
 * generations.
 *
 * `created_at` is the primary ordering field. The numeric cache ID provides
 * deterministic ordering if two entries share the same creation timestamp.
 */
function findObsoleteCaches(groups) {
  const obsoleteCaches = [];

  for (const groupCaches of groups.values()) {
    groupCaches.sort(compareNewestFirst);

    // Index 0 is the newest cache generation and is retained.
    obsoleteCaches.push(...groupCaches.slice(1));
  }

  return obsoleteCaches;
}

function compareNewestFirst(left, right) {
  const leftCreatedAt = Date.parse(left.created_at);
  const rightCreatedAt = Date.parse(right.created_at);

  if (!Number.isFinite(leftCreatedAt)) {
    throw new Error(
      `Cache "${left.key}" has an invalid created_at value: ` +
        `"${left.created_at}".`,
    );
  }

  if (!Number.isFinite(rightCreatedAt)) {
    throw new Error(
      `Cache "${right.key}" has an invalid created_at value: ` +
        `"${right.created_at}".`,
    );
  }

  const createdDifference = rightCreatedAt - leftCreatedAt;

  if (createdDifference !== 0) {
    return createdDifference;
  }

  return right.id - left.id;
}

async function deleteCache({
  apiUrl,
  token,
  owner,
  repo,
  cacheId,
}) {
  const url = new URL(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
      `/actions/caches/${cacheId}`,
    apiUrl,
  );

  // A 404 means the cache is already gone, which is the desired end state. This
  // happens when a concurrent prune run deleted the same obsolete cache first,
  // so treat it as success rather than turning it into a spurious failure.
  await githubRequest(url, {
    token,
    method: 'DELETE',
    ignoreStatuses: [404],
  });
}

async function githubRequest(url, { token, method, ignoreStatuses = [] }) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'prune-cache',
    },
  });

  if (!response.ok && !ignoreStatuses.includes(response.status)) {
    const responseBody = await response.text();

    throw new Error(
      `GitHub API request failed: ${method} ${url.pathname}\n` +
        `HTTP ${response.status} ${response.statusText}\n` +
        responseBody,
    );
  }

  return response;
}

function parseBoolean(value) {
  const normalizedValue = value.trim().toLowerCase();

  if (normalizedValue === 'true') {
    return true;
  }

  if (normalizedValue === 'false') {
    return false;
  }

  throw new Error(
    `Invalid dry-run value "${value}". Expected "true" or "false".`,
  );
}

function requireEnvironmentVariable(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Required environment variable ${name} is not available.`);
  }

  return value;
}

function fail(message) {
  throw new Error(message);
}

function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

function escapeWorkflowCommand(value) {
  return String(value)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

main().catch((error) => {
  console.error(`::error::${escapeWorkflowCommand(error.message)}`);
  process.exitCode = 1;
});
