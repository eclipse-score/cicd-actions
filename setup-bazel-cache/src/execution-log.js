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

import { spawn } from 'node:child_process';

const EXECUTION_LOG_METRIC_NOTE =
  'This view counts work that can reuse a cached result; it does not represent every Bazel cache lookup.';

/**
 * Read the compact log stream emitted by Bazel's --execution_log_compact_file.
 *
 * The compact format is a zstd stream of length-delimited ExecLogEntry
 * protobufs. We intentionally decode only ExecLogEntry.spawn.cacheable,
 * ExecLogEntry.spawn.cache_hit, and ExecLogEntry.spawn.runner. Keeping this
 * narrow makes the reporting path cheap while preserving a seam for replacing
 * this decoder with Bazel's official execlog parser in the future.
 */
async function summarizeExecutionLog(logPath) {
  const parser = new CompactExecutionLogParser();
  let decoderError = null;

  await new Promise((resolve) => {
    const decoder = spawn('zstd', ['--decompress', '--stdout', '--quiet', logPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    decoder.on('error', (error) => {
      decoderError = error;
      finish();
    });
    decoder.stdout.on('data', (chunk) => {
      try {
        parser.push(chunk);
      } catch (error) {
        parser.markPartial(error);
        decoder.kill();
      }
    });
    decoder.on('close', (code, signal) => {
      if (code !== 0 || signal) {
        decoderError = new Error(
          `zstd exited with ${signal ? `signal ${signal}` : `status ${code}`}`,
        );
      }
      finish();
    });
  });

  parser.finish();
  return {
    ...summarizeSpawns(parser.spawns),
    partial: parser.partial || Boolean(decoderError),
    decoderError,
  };
}

/** Aggregate the three spawn fields used by the cache report. */
function summarizeSpawns(spawns) {
  const hits = new Map();
  const executed = new Map();
  let hitCount = 0;
  let executedCount = 0;

  for (const spawnRecord of spawns) {
    if (!spawnRecord.cacheable) continue;
    const runner = spawnRecord.runner || 'unknown';
    if (spawnRecord.cacheHit) {
      hitCount += 1;
      hits.set(runner, (hits.get(runner) || 0) + 1);
    } else {
      executedCount += 1;
      executed.set(runner, (executed.get(runner) || 0) + 1);
    }
  }

  return {
    hits: hitCount,
    executed: executedCount,
    observed: hitCount + executedCount,
    hitRunners: sortRunnerCounts(hits),
    executedRunners: sortRunnerCounts(executed),
  };
}

function sortRunnerCounts(counts) {
  return [...counts.entries()]
    .sort(([leftName, leftCount], [rightName, rightCount]) =>
      rightCount - leftCount || leftName.localeCompare(rightName))
    .map(([runner, count]) => ({ runner, count }));
}

/**
 * Parse one compact-log entry. The top-level fields are defined by Bazel's
 * spawn.proto; all fields other than the Spawn payload are skipped.
 */
function parseExecutionLogEntry(entry) {
  let offset = 0;
  let spawnRecord = null;
  while (offset < entry.length) {
    const key = readVarint(entry, offset);
    offset = key.offset;
    const fieldNumber = Number(key.value >> 3n);
    const wireType = Number(key.value & 7n);
    const field = readField(entry, offset, wireType);
    offset = field.offset;
    if (fieldNumber === 7 && wireType === 2) {
      spawnRecord = parseSpawn(field.value);
    }
  }
  return spawnRecord;
}

/** Parse only Spawn.runner, Spawn.cache_hit, and Spawn.cacheable. */
function parseSpawn(message) {
  let offset = 0;
  const spawnRecord = {
    runner: '',
    cacheHit: false,
    cacheable: false,
  };
  while (offset < message.length) {
    const key = readVarint(message, offset);
    offset = key.offset;
    const fieldNumber = Number(key.value >> 3n);
    const wireType = Number(key.value & 7n);
    const field = readField(message, offset, wireType);
    offset = field.offset;
    if (wireType === 2 && fieldNumber === 11) {
      spawnRecord.runner = field.value.toString('utf8');
    } else if (wireType === 0 && fieldNumber === 12) {
      spawnRecord.cacheHit = field.value !== 0n;
    } else if (wireType === 0 && fieldNumber === 14) {
      spawnRecord.cacheable = field.value !== 0n;
    }
  }
  return spawnRecord;
}

function readField(buffer, offset, wireType) {
  if (wireType === 0) {
    const value = readVarint(buffer, offset);
    return { offset: value.offset, value: value.value };
  }
  if (wireType === 1) return ensureField(buffer, offset, 8, buffer.subarray(offset, offset + 8));
  if (wireType === 2) {
    const length = readVarint(buffer, offset);
    const end = length.offset + toSafeNumber(length.value, 'protobuf length');
    if (end > buffer.length) throw new Error('truncated length-delimited protobuf field');
    return { offset: end, value: buffer.subarray(length.offset, end) };
  }
  if (wireType === 5) return ensureField(buffer, offset, 4, buffer.subarray(offset, offset + 4));
  throw new Error(`unsupported protobuf wire type ${wireType}`);
}

function ensureField(buffer, offset, size, value) {
  if (offset + size > buffer.length) throw new Error('truncated protobuf field');
  return { offset: offset + size, value };
}

function readVarint(buffer, start) {
  let value = 0n;
  let shift = 0n;
  for (let offset = start; offset < buffer.length; offset += 1) {
    const byte = BigInt(buffer[offset]);
    value |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) return { offset: offset + 1, value };
    shift += 7n;
    if (shift > 63n) throw new Error('protobuf varint is too long');
  }
  throw new Error('truncated protobuf varint');
}

function toSafeNumber(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} is outside the supported range`);
  }
  return number;
}

/** Stream length-delimited protobuf entries without retaining the whole log. */
class CompactExecutionLogParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.spawns = [];
    this.partial = false;
  }

  push(chunk) {
    if (chunk.length === 0) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.consume();
  }

  consume() {
    while (this.buffer.length > 0) {
      let length;
      try {
        length = readVarint(this.buffer, 0);
      } catch (error) {
        if (/truncated protobuf varint/.test(error.message)) return;
        throw error;
      }
      const entryLength = toSafeNumber(length.value, 'execution-log entry length');
      const entryEnd = length.offset + entryLength;
      if (entryEnd > this.buffer.length) return;
      const spawnRecord = parseExecutionLogEntry(
        this.buffer.subarray(length.offset, entryEnd),
      );
      if (spawnRecord) this.spawns.push(spawnRecord);
      this.buffer = this.buffer.subarray(entryEnd);
    }
  }

  markPartial(error) {
    this.partial = true;
    this.error = error;
  }

  finish() {
    if (this.buffer.length > 0) this.partial = true;
  }
}

export {
  EXECUTION_LOG_METRIC_NOTE,
  parseExecutionLogEntry,
  summarizeExecutionLog,
  summarizeSpawns,
};
