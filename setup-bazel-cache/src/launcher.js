#!/usr/bin/env node
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

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  claimInvocation,
  finishInvocation,
  invocationFilePaths,
  MEASURED_COMMANDS,
} from './invocation.js';

/** Locate the first Bazel command after startup options. */
function findMeasuredCommand(args) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') return null;
    if (argument.startsWith('-')) continue;
    if (MEASURED_COMMANDS.includes(argument)) return { command: argument, index };
    return null;
  }
  return null;
}

function envEnabled(name) {
  return process.env[name]?.trim().toLowerCase() === 'true';
}

function resolveRealExecutable(command) {
  const wrapperDirectory = process.env.SETUP_BAZEL_CACHE_LAUNCHER_DIR
    ? path.resolve(process.env.SETUP_BAZEL_CACHE_LAUNCHER_DIR)
    : null;
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    const directory = entry || process.cwd();
    if (wrapperDirectory && path.resolve(directory) === wrapperDirectory) continue;
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Continue searching PATH just as the shell would.
    }
  }
  throw new Error(`Could not find the underlying '${command}' executable outside the launcher directory.`);
}

function signalExitCode(signal) {
  const signals = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
  return 128 + (signals[signal] || 1);
}

function runProcess(executable, args) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { stdio: 'inherit' });
    const forwardSignals = ['SIGINT', 'SIGTERM'].map((signal) => {
      const handler = () => child.kill(signal);
      process.on(signal, handler);
      return [signal, handler];
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      for (const [name, handler] of forwardSignals) process.removeListener(name, handler);
      resolve(result);
    };
    child.on('error', (error) => {
      console.error(`setup-bazel-cache launcher could not start Bazel: ${error.message}`);
      finish({ code: 127, signal: null });
    });
    child.on('exit', (code, signal) => {
      finish({ code: code ?? signalExitCode(signal), signal });
    });
  });
}

/**
 * Add only this process's output destinations after the Bazel command. Bazel
 * accepts command options there, and placing them before caller arguments
 * keeps normal command-line precedence: an explicit later caller option may
 * intentionally replace the action's destination.
 */
function instrumentedArgs(args, commandIndex, files, metrics = {}) {
  const flags = [];
  if (metrics.executionLog ?? envEnabled('SETUP_BAZEL_CACHE_REPORT_CACHE_HITS')) {
    flags.push(`--execution_log_compact_file=${files.executionLog}`);
  }
  if ((metrics.testCache ?? envEnabled('SETUP_BAZEL_CACHE_REPORT_TEST_CACHE_HITS')) &&
      (files.testCache !== undefined && files.testCache !== null)) {
    flags.push(
      `--build_event_json_file=${files.testCache}`,
      '--nobuild_event_json_file_path_conversion',
    );
  }
  if (metrics.profile ?? envEnabled('SETUP_BAZEL_CACHE_ENABLE_PROFILING')) {
    flags.push(`--profile=${files.profile}`);
  }
  return [
    ...args.slice(0, commandIndex + 1),
    ...flags,
    ...args.slice(commandIndex + 1),
  ];
}

async function run() {
  const args = process.argv.slice(2);
  const launcherCommand = process.env.SETUP_BAZEL_CACHE_LAUNCHER_COMMAND;
  const commandInfo = findMeasuredCommand(args);
  const root = process.env.SETUP_BAZEL_CACHE_INVOCATION_ROOT;
  const metrics = {
    executionLog: envEnabled('SETUP_BAZEL_CACHE_REPORT_CACHE_HITS'),
    testCache: envEnabled('SETUP_BAZEL_CACHE_REPORT_TEST_CACHE_HITS') &&
      commandInfo?.command !== 'build' && commandInfo?.command !== 'run',
    profile: envEnabled('SETUP_BAZEL_CACHE_ENABLE_PROFILING'),
  };
  const shouldInstrument = Boolean(launcherCommand && commandInfo && root &&
    (metrics.executionLog || metrics.testCache || metrics.profile));
  if (!shouldInstrument) {
    const executable = resolveRealExecutable(launcherCommand || 'bazel');
    const result = await runProcess(executable, args);
    process.exitCode = result.code;
    return;
  }

  let record;
  try {
    record = claimInvocation(root, commandInfo.command, metrics);
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
    return;
  }

  let executable;
  try {
    executable = resolveRealExecutable(launcherCommand);
  } catch (error) {
    finishInvocation(record, 127);
    console.error(error.message || error);
    process.exitCode = 127;
    return;
  }

  const files = invocationFilePaths(record.directory);
  const result = await runProcess(
    executable,
    instrumentedArgs(args, commandInfo.index, files, metrics),
  );
  finishInvocation(record, result.code, result.signal);
  process.exitCode = result.code;
}

if (process.env.SETUP_BAZEL_CACHE_LAUNCHER_RUN === 'true') {
  run().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}

export {
  findMeasuredCommand,
  instrumentedArgs,
  resolveRealExecutable,
  run,
  signalExitCode,
};
