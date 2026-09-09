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
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  clearExecutionLogs,
  executionLogPaths,
  parseExecutionLogEntry,
  summarizeExecutionLog,
  summarizeSpawns,
} from '../src/execution-log.js';

function varint(value) {
  const bytes = [];
  let remaining = BigInt(value);
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0n);
  return Buffer.from(bytes);
}

function field(number, wireType, value) {
  const key = varint((BigInt(number) << 3n) | BigInt(wireType));
  if (wireType === 0) return Buffer.concat([key, varint(value)]);
  return Buffer.concat([key, varint(value.length), value]);
}

function spawnEntry({ runner, cacheHit, cacheable }) {
  const spawn = Buffer.concat([
    field(11, 2, Buffer.from(runner)),
    field(12, 0, cacheHit ? 1 : 0),
    field(14, 0, cacheable ? 1 : 0),
  ]);
  const entry = field(7, 2, spawn);
  return Buffer.concat([varint(entry.length), entry]);
}

function compressedLog(entries) {
  const uncompressed = Buffer.concat(entries.map(spawnEntry));
  return execFileSync('zstd', ['--compress', '--stdout', '--quiet'], {
    input: uncompressed,
  });
}

test('compact execution-log classification includes only cacheable spawns', () => {
  const summary = summarizeSpawns([
    { runner: 'disk cache hit', cacheHit: true, cacheable: true },
    { runner: 'processwrapper-sandbox', cacheHit: false, cacheable: true },
    { runner: 'ignored', cacheHit: false, cacheable: false },
  ]);

  assert.deepEqual(summary, {
    hits: 1,
    executed: 1,
    observed: 2,
    hitRunners: [{ runner: 'disk cache hit', count: 1 }],
    executedRunners: [{ runner: 'processwrapper-sandbox', count: 1 }],
  });
});

test('compact execution logs are decoded and grouped by runner', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-bazel-cache-execution-log-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const log = path.join(directory, 'build.exec.log.zst');
  fs.writeFileSync(log, compressedLog([
    ...Array.from({ length: 2 }, () => ({
      runner: 'disk cache hit',
      cacheHit: true,
      cacheable: true,
    })),
    { runner: 'processwrapper-sandbox', cacheHit: false, cacheable: true },
    { runner: 'local', cacheHit: false, cacheable: true },
    { runner: 'ignored', cacheHit: false, cacheable: false },
  ]));

  const summary = await summarizeExecutionLog(log);
  assert.equal(summary.partial, false);
  assert.equal(summary.hits, 2);
  assert.equal(summary.observed, 4);
  assert.deepEqual(summary.hitRunners, [{ runner: 'disk cache hit', count: 2 }]);
  assert.deepEqual(summary.executedRunners, [
    { runner: 'local', count: 1 },
    { runner: 'processwrapper-sandbox', count: 1 },
  ]);
});

test('truncated compact logs return partial results instead of failing', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-bazel-cache-truncated-log-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const log = path.join(directory, 'build.exec.log.zst');
  const compressed = compressedLog([
    { runner: 'disk cache hit', cacheHit: true, cacheable: true },
    { runner: 'processwrapper-sandbox', cacheHit: false, cacheable: true },
  ]);
  fs.writeFileSync(log, compressed.subarray(0, Math.max(1, compressed.length - 2)));

  const summary = await summarizeExecutionLog(log);
  assert.equal(summary.partial, true);
});

test('managed execution-log paths are separate and removable', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-bazel-cache-log-paths-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const logs = executionLogPaths(directory);
  for (const log of Object.values(logs)) fs.writeFileSync(log, 'stale');
  clearExecutionLogs(logs);
  assert.deepEqual(Object.values(logs).map(fs.existsSync), [false, false, false]);
  assert.notEqual(logs.build, logs.test);
  assert.notEqual(logs.test, logs.coverage);
});

test('spawn entries use the Bazel compact-log field numbers', () => {
  assert.deepEqual(
    parseExecutionLogEntry(spawnEntry({
      runner: 'worker',
      cacheHit: false,
      cacheable: true,
    }).subarray(1)),
    { runner: 'worker', cacheHit: false, cacheable: true },
  );
});
