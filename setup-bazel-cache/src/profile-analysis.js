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
import zlib from 'node:zlib';

const PHASE_MARKER_NAMES = [
  'Initialize command',
  'Evaluate target patterns',
  'Load, analyze dependencies and build artifacts',
  'Complete build',
];

function eventEnd(event) {
  return event.ts + (event.dur || 0);
}

/**
 * Summarize a Bazel JSON trace profile without starting another Bazel server.
 * Action durations are cumulative across concurrent actions, so they describe
 * resource consumption rather than wall-clock time.
 */
function summarizeProfile(profile, name = 'profile') {
  if (!profile || !Array.isArray(profile.traceEvents)) {
    throw new Error('Bazel profile does not contain a traceEvents array');
  }

  const events = profile.traceEvents.filter((event) => Number.isFinite(event.ts));
  if (events.length === 0) throw new Error('Bazel profile contains no timed events');

  const initialize = events.find(
    (event) => event.cat === 'build phase marker' && event.name === 'Initialize command',
  );
  const start = initialize?.ts ?? Math.min(...events.map((event) => event.ts));
  const end = Math.max(...events.map(eventEnd));
  const criticalPathSeconds = events
    .filter((event) => event.cat === 'critical path component' && event.ph === 'X')
    .reduce((total, event) => total + (event.dur || 0), 0) / 1e6;

  const markers = new Map(
    events
      .filter((event) => event.cat === 'build phase marker' && PHASE_MARKER_NAMES.includes(event.name))
      .map((event) => [event.name, event.ts]),
  );
  const phaseDurations = PHASE_MARKER_NAMES
    .slice(0, -1)
    .map((from, index) => {
      const to = PHASE_MARKER_NAMES[index + 1];
      const fromTime = markers.get(from);
      const toTime = markers.get(to);
      if (!Number.isFinite(fromTime) || !Number.isFinite(toTime)) return null;
      return {
        from,
        to,
        seconds: (toTime - fromTime) / 1e6,
      };
    })
    .filter(Boolean);

  const actionStats = new Map();
  for (const event of events) {
    if (event.cat !== 'action processing' || event.ph !== 'X' || !event.args?.mnemonic) continue;
    const mnemonic = event.args.mnemonic;
    const current = actionStats.get(mnemonic) || { mnemonic, count: 0, totalMicros: 0, maxMicros: 0 };
    current.count += 1;
    current.totalMicros += event.dur || 0;
    current.maxMicros = Math.max(current.maxMicros, event.dur || 0);
    actionStats.set(mnemonic, current);
  }

  return {
    name,
    bazelVersion: profile.otherData?.bazel_version || 'unknown',
    totalSeconds: (end - start) / 1e6,
    criticalPathSeconds,
    phaseDurations,
    actionEventCount: [...actionStats.values()].reduce((total, action) => total + action.count, 0),
    actionStats: [...actionStats.values()]
      .map((action) => ({
        mnemonic: action.mnemonic,
        count: action.count,
        totalSeconds: action.totalMicros / 1e6,
        maxSeconds: action.maxMicros / 1e6,
      }))
      .sort((left, right) => right.totalSeconds - left.totalSeconds),
  };
}

/** Read and summarize one gzip-compressed Bazel JSON trace profile. */
function summarizeProfileFile(profilePath) {
  const contents = zlib.gunzipSync(fs.readFileSync(profilePath));
  return summarizeProfile(JSON.parse(contents), profilePath);
}

export {
  summarizeProfile,
  summarizeProfileFile,
};
