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
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  claimInvocation,
  finishInvocation,
  formatInvocationSequence,
  initializeInvocationStore,
  listInvocations,
  MAX_INVOCATIONS,
  invocationFilePaths,
  invocationRootPath,
} from '../src/invocation.js';
import { findMeasuredCommand, findTargetPatterns } from '../src/launcher.js';

function temporaryRoot(context, prefix = 'setup-bazel-cache-invocations-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('launcher recognizes measured Bazel commands after startup options', () => {
  assert.deepEqual(findMeasuredCommand(['--batch', 'build', '//:all']), { command: 'build', index: 1 });
  assert.deepEqual(findMeasuredCommand(['--output_base=/tmp/base', 'test']), { command: 'test', index: 1 });
  assert.equal(findMeasuredCommand(['query', '//:all']), null);
  assert.equal(findMeasuredCommand(['--', 'build']), null);
});

test('launcher captures target patterns while excluding options and run arguments', () => {
  assert.deepEqual(
    findTargetPatterns(['run', '--run_under', 'value', '//pkg:binary', '@rules//:tool', '--', '//:program-arg'], 0),
    ['//pkg:binary', '@rules//:tool'],
  );
});

test('invocation claims are unique, ordered, and retain completed metadata', (context) => {
  const root = temporaryRoot(context);
  initializeInvocationStore(root);
  const first = claimInvocation(root, 'build', {
    executionLog: true,
    testCache: false,
    profile: true,
  }, ['//:all']);
  const second = claimInvocation(root, 'test', {
    executionLog: false,
    testCache: true,
    profile: false,
  });
  finishInvocation(first, 0);

  assert.equal(first.metadata.sequence, 0);
  assert.equal(second.metadata.sequence, 1);
  assert.equal(fs.existsSync(invocationFilePaths(first.directory).executionLog), false);
  assert.equal(JSON.parse(fs.readFileSync(first.metadataPath, 'utf8')).completed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(first.metadataPath, 'utf8')).targets, ['//:all']);
  assert.deepEqual(listInvocations(root).map(({ sequence, command }) => ({ sequence, command })), [
    { sequence: 0, command: 'build' },
    { sequence: 1, command: 'test' },
  ]);
});

test('three-digit sequence allocation hard-fails before a 1000th invocation', (context) => {
  const root = temporaryRoot(context);
  initializeInvocationStore(root);
  for (let sequence = 0; sequence < MAX_INVOCATIONS; sequence += 1) {
    fs.writeFileSync(
      path.join(root, '.claims', `${formatInvocationSequence(sequence)}.claim`),
      'reserved\n',
    );
  }

  assert.throws(
    () => claimInvocation(root, 'build', { executionLog: true, testCache: false, profile: false }),
    /only sequences 000 through 999 are supported/,
  );
  assert.deepEqual(fs.readdirSync(root), ['.claims']);
});

test('custom launcher instruments every invocation and preserves Bazel exit status', (context) => {
  const root = temporaryRoot(context);
  const invocationRoot = invocationRootPath(root);
  const fakeBin = path.join(root, 'fake-bin');
  fs.mkdirSync(fakeBin);
  const argsFile = path.join(root, 'bazel-args.txt');
  const fakeBazel = path.join(fakeBin, 'bazel');
  fs.writeFileSync(fakeBazel, [
    '#!/bin/sh',
    'if [ "$1" = "--batch" ]; then shift; fi',
    'printf "%s\\n" "$@" > "$SETUP_TEST_BAZEL_ARGS.$1"',
    'exit "${SETUP_TEST_BAZEL_EXIT:-0}"',
    '',
  ].join('\n'));
  fs.chmodSync(fakeBazel, 0o755);
  initializeInvocationStore(invocationRoot);

  const launcher = fileURLToPath(new URL('../src/launcher.js', import.meta.url));
  const env = {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    SETUP_TEST_BAZEL_ARGS: argsFile,
    SETUP_BAZEL_CACHE_LAUNCHER_RUN: 'true',
    SETUP_BAZEL_CACHE_LAUNCHER_COMMAND: 'bazel',
    SETUP_BAZEL_CACHE_LAUNCHER_DIR: path.join(root, 'launcher-bin'),
    SETUP_BAZEL_CACHE_INVOCATION_ROOT: invocationRoot,
    SETUP_BAZEL_CACHE_ENABLE_PROFILING: 'true',
    SETUP_BAZEL_CACHE_REPORT_CACHE_HITS: 'true',
    SETUP_BAZEL_CACHE_REPORT_TEST_CACHE_HITS: 'true',
  };
  execFileSync(process.execPath, [launcher, 'info', 'output_base'], { env });
  execFileSync(process.execPath, [launcher, '--batch', 'build', '//:all'], { env });
  execFileSync(process.execPath, [launcher, 'test', '//:all'], { env });
  const failed = spawnSync(process.execPath, [launcher, 'build', '//:all'], {
    env: { ...env, SETUP_TEST_BAZEL_EXIT: '17' },
    encoding: 'utf8',
  });
  assert.equal(failed.status, 17);

  const invocations = listInvocations(invocationRoot);
  assert.deepEqual(invocations.map(({ sequence, command }) => ({ sequence, command })), [
    { sequence: 0, command: 'build' },
    { sequence: 1, command: 'test' },
    { sequence: 2, command: 'build' },
  ]);
  assert.deepEqual(fs.readFileSync(`${argsFile}.test`, 'utf8').trim().split('\n'), [
    'test',
    `--execution_log_compact_file=${invocations[1].files.executionLog}`,
    `--build_event_json_file=${invocations[1].files.testCache}`,
    '--nobuild_event_json_file_path_conversion',
    `--profile=${invocations[1].files.profile}`,
    '//:all',
  ]);
  assert.doesNotMatch(fs.readFileSync(`${argsFile}.build`, 'utf8'), /build_event_json_file/);
  assert.equal(JSON.parse(fs.readFileSync(invocations[0].metadataPath, 'utf8')).exitCode, 0);
  assert.equal(JSON.parse(fs.readFileSync(invocations[2].metadataPath, 'utf8')).exitCode, 17);
});
