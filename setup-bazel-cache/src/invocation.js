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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const INVOCATION_ROOT_NAME = 'setup-bazel-cache-invocations';
const INVOCATION_WIDTH = 3;
const MAX_INVOCATIONS = 10 ** INVOCATION_WIDTH;
const MEASURED_COMMANDS = Object.freeze(['build', 'run', 'test', 'coverage']);
const INVOCATION_FILE_NAMES = Object.freeze({
  executionLog: 'execution.log.zst',
  testCache: 'test.bep.json',
  profile: 'profile.gz',
});

function invocationRootPath(runnerTemp = process.env.RUNNER_TEMP || os.tmpdir()) {
  return path.join(runnerTemp, INVOCATION_ROOT_NAME);
}

function wrapperDirectoryPath(runnerTemp = process.env.RUNNER_TEMP || os.tmpdir()) {
  return path.join(runnerTemp, 'setup-bazel-cache-bin');
}

/**
 * Remove stale action-owned records and create the directory used by launchers.
 * A job gets one fresh store, so records can never be confused with a previous
 * setup-bazel-cache action invocation that used the same runner temporary area.
 */
function initializeInvocationStore(root) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, '.claims'), { recursive: true });
}

function formatInvocationSequence(sequence) {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence >= MAX_INVOCATIONS) {
    throw new Error(`Invocation sequence must be between 0 and ${MAX_INVOCATIONS - 1}`);
  }
  return sequence.toString().padStart(INVOCATION_WIDTH, '0');
}

function invocationDirectoryName(sequence, command) {
  return `${formatInvocationSequence(sequence)}-${command}`;
}

function invocationFilePaths(directory) {
  return Object.fromEntries(
    Object.entries(INVOCATION_FILE_NAMES).map(([name, fileName]) => [
      name,
      path.join(directory, fileName),
    ]),
  );
}

function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`);
  fs.renameSync(temporaryPath, filePath);
}

/**
 * Claim the first unused sequence with O_EXCL. Keeping claims forever makes
 * sequence allocation monotonic without requiring a shared lock or a counter
 * that could be corrupted by two concurrent Bazel launchers.
 */
function claimInvocation(root, command, metrics = {}) {
  if (!MEASURED_COMMANDS.includes(command)) {
    throw new Error(`Cannot capture unsupported Bazel command '${command}'.`);
  }
  const claims = path.join(root, '.claims');
  fs.mkdirSync(claims, { recursive: true });

  for (let sequence = 0; sequence < MAX_INVOCATIONS; sequence += 1) {
    const formattedSequence = formatInvocationSequence(sequence);
    const claimPath = path.join(claims, `${formattedSequence}.claim`);
    let descriptor;
    try {
      descriptor = fs.openSync(claimPath, 'wx');
      fs.writeSync(descriptor, `${process.pid}\n`);
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }

    const directory = path.join(root, invocationDirectoryName(sequence, command));
    fs.mkdirSync(directory);
    const files = invocationFilePaths(directory);
    const metadata = {
      schemaVersion: 1,
      sequence,
      command,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      completed: false,
      exitCode: null,
      signal: null,
      metrics: {
        executionLog: Boolean(metrics.executionLog),
        testCache: Boolean(metrics.testCache),
        profile: Boolean(metrics.profile),
      },
      files: Object.fromEntries(
        Object.entries(files).map(([name, filePath]) => [
          name,
          metadataFileName(filePath, Boolean(metrics[name])),
        ]),
      ),
    };
    const metadataPath = path.join(directory, 'metadata.json');
    writeJsonAtomically(metadataPath, metadata);
    return { directory, files, metadata, metadataPath };
  }

  throw new Error(
    'setup-bazel-cache measured invocation limit exceeded: only sequences 000 through 999 are supported.',
  );
}

function metadataFileName(filePath, enabled) {
  return enabled ? path.basename(filePath) : null;
}

/** Mark an invocation complete while retaining partial records after crashes. */
function finishInvocation(record, exitCode, signal = null) {
  const metadata = {
    ...record.metadata,
    finishedAt: new Date().toISOString(),
    completed: true,
    exitCode,
    signal,
    outputs: Object.fromEntries(
      Object.entries(record.files).map(([name, filePath]) => [name, fs.existsSync(filePath)]),
    ),
  };
  writeJsonAtomically(record.metadataPath, metadata);
  return metadata;
}

function invocationLabel(invocation) {
  return `${formatInvocationSequence(invocation.sequence)}-${invocation.command}`;
}

/** Discover only records created by this action and retain their sequence order. */
function listInvocations(root = invocationRootPath()) {
  if (!fs.existsSync(root)) return [];
  const records = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.claims') continue;
    const match = /^(\d{3})-(build|run|test|coverage)$/.exec(entry.name);
    if (!match) continue;
    const directory = path.join(root, entry.name);
    const metadataPath = path.join(directory, 'metadata.json');
    let metadata;
    try {
      metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    } catch (error) {
      metadata = {
        schemaVersion: 1,
        sequence: Number(match[1]),
        command: match[2],
        completed: false,
        metadataError: error.code || 'INVALID_METADATA',
        metrics: {},
      };
    }
    const sequence = Number(match[1]);
    records.push({
      ...metadata,
      directory,
      files: invocationFilePaths(directory),
      metadataPath,
      sequence,
      command: match[2],
    });
  }
  return records.sort((left, right) => left.sequence - right.sequence);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Install thin shell shims that preserve the original command names. */
function installBazelLaunchers({ launcherPath, wrapperDirectory }) {
  fs.rmSync(wrapperDirectory, { recursive: true, force: true });
  fs.mkdirSync(wrapperDirectory, { recursive: true });
  for (const command of ['bazel', 'bazelisk']) {
    const wrapperPath = path.join(wrapperDirectory, command);
    fs.writeFileSync(wrapperPath, [
      '#!/bin/sh',
      `export SETUP_BAZEL_CACHE_LAUNCHER_COMMAND=${shellQuote(command)}`,
      `export SETUP_BAZEL_CACHE_LAUNCHER_DIR=${shellQuote(wrapperDirectory)}`,
      'export SETUP_BAZEL_CACHE_LAUNCHER_RUN=true',
      `exec ${shellQuote(process.execPath)} ${shellQuote(launcherPath)} "$@"`,
      '',
    ].join('\n'));
    fs.chmodSync(wrapperPath, 0o755);
  }
}

export {
  INVOCATION_FILE_NAMES,
  INVOCATION_ROOT_NAME,
  INVOCATION_WIDTH,
  MAX_INVOCATIONS,
  MEASURED_COMMANDS,
  claimInvocation,
  finishInvocation,
  formatInvocationSequence,
  initializeInvocationStore,
  installBazelLaunchers,
  invocationDirectoryName,
  invocationFilePaths,
  invocationLabel,
  invocationRootPath,
  listInvocations,
  shellQuote,
  wrapperDirectoryPath,
};
