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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  describeLocalCachePath,
  formatBytes,
  localPathSize,
} from '../src/cache-size.js';

test('local cache sizes are formatted compactly and ignore symlinks', (context) => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), 'setup-bazel-cache-size-test-'),
  );
  context.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  fs.writeFileSync(path.join(workspace, 'small'), '123');
  fs.mkdirSync(path.join(workspace, 'nested'));
  fs.writeFileSync(path.join(workspace, 'nested', 'large'), 'x'.repeat(1024));
  fs.symlinkSync(path.join(workspace, 'small'), path.join(workspace, 'ignored-link'));

  assert.equal(localPathSize(workspace), 1027);
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.00 KiB');
  assert.equal(formatBytes(1024 * 1024), '1.00 MiB');
});

test('empty cache diagnostics distinguish missing and empty paths', (context) => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), 'setup-bazel-cache-empty-diagnostics-'),
  );
  context.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const empty = path.join(workspace, 'empty');
  const missing = path.join(workspace, 'missing');
  fs.mkdirSync(empty);

  assert.equal(describeLocalCachePath(empty), `${empty}: empty directory`);
  assert.equal(describeLocalCachePath(missing), `${missing}: missing`);
});
