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

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const { KVM_DEVICE, hasCommand } = require('./common');

function main() {
  if (!fs.existsSync(KVM_DEVICE)) {
    console.log(`${KVM_DEVICE} not present; skipping KVM ACL setup.`);
    return;
  }

  if (!hasCommand('setfacl')) {
    console.log('setfacl not found; installing the "acl" package.');
    execFileSync('sudo', ['apt-get', 'update'], { stdio: 'inherit' });
    execFileSync('sudo', ['apt-get', 'install', '-y', 'acl'], { stdio: 'inherit' });
  }

  const user = os.userInfo().username;
  const originalAcl = execFileSync('getfacl', ['--absolute-names', KVM_DEVICE], { encoding: 'utf8' });
  fs.appendFileSync(process.env.GITHUB_STATE,
    `original-acl=${Buffer.from(originalAcl).toString('base64')}\n`);
  const entries = originalAcl.split('\n')
    .filter(line => line.trim() && !line.startsWith('#'))
    .map(line => {
      const entry = line.match(/^(user|group|mask|other):([^:]*):([r-][w-][x-])(?:\s+#.*)?$/);
      if (!entry) throw new Error(`Unexpected KVM ACL entry: ${line}`);
      return { type: entry[1], name: entry[2], permissions: entry[3] };
    });
  const mask = entries.find(entry => entry.type === 'mask')?.permissions || 'rwx';
  // Clip masked entries before widening the mask, so only the runner gains access.
  const modifications = entries
    .filter(entry => entry.type === 'group' ||
      (entry.type === 'user' && entry.name && entry.name !== user))
    .map(entry => {
      const effective = Array.from(entry.permissions,
        (permission, index) => permission === mask[index] ? permission : '-').join('');
      return `${entry.type}:${entry.name}:${effective}`;
    });
  modifications.push(`user:${user}:rw-`, `mask::rw${mask[2]}`);
  execFileSync('sudo', ['setfacl', '--no-mask', '-m', modifications.join(','), KVM_DEVICE], { stdio: 'inherit' });
  console.log(`Granted ${user} rw ACL access to ${KVM_DEVICE}.`);
}

main();
