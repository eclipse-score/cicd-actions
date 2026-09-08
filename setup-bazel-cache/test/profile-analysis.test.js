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
import test from 'node:test';
import { summarizeProfile } from '../src/profile-analysis.js';

test('profile analysis reports phase, critical-path, and action timing summaries', () => {
  const profile = {
    otherData: { bazel_version: 'release 8.6.0' },
    traceEvents: [
      { cat: 'build phase marker', name: 'Initialize command', ph: 'i', ts: 0 },
      { cat: 'build phase marker', name: 'Evaluate target patterns', ph: 'i', ts: 1e6 },
      {
        cat: 'build phase marker',
        name: 'Load, analyze dependencies and build artifacts',
        ph: 'i',
        ts: 3e6,
      },
      { cat: 'build phase marker', name: 'Complete build', ph: 'i', ts: 10e6 },
      { cat: 'critical path component', ph: 'X', ts: 4e6, dur: 5e6 },
      { cat: 'action processing', ph: 'X', ts: 4e6, dur: 2e6, args: { mnemonic: 'CppCompile' } },
      { cat: 'action processing', ph: 'X', ts: 6e6, dur: 1e6, args: { mnemonic: 'CppCompile' } },
      { cat: 'action processing', ph: 'X', ts: 7e6, dur: 2e6, args: { mnemonic: 'TestRunner' } },
    ],
  };

  assert.deepEqual(summarizeProfile(profile, 'test-profile'), {
    name: 'test-profile',
    bazelVersion: 'release 8.6.0',
    totalSeconds: 10,
    criticalPathSeconds: 5,
    phaseDurations: [
      { from: 'Initialize command', to: 'Evaluate target patterns', seconds: 1 },
      {
        from: 'Evaluate target patterns',
        to: 'Load, analyze dependencies and build artifacts',
        seconds: 2,
      },
      {
        from: 'Load, analyze dependencies and build artifacts',
        to: 'Complete build',
        seconds: 7,
      },
    ],
    actionEventCount: 3,
    actionStats: [
      { mnemonic: 'CppCompile', count: 2, totalSeconds: 3, maxSeconds: 2 },
      { mnemonic: 'TestRunner', count: 1, totalSeconds: 2, maxSeconds: 2 },
    ],
  });
});
