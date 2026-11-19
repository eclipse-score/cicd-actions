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
const { KVM_DEVICE } = require('./common');

function main() {
  const originalAcl = process.env['STATE_original-acl'];
  if (!originalAcl || !fs.existsSync(KVM_DEVICE)) {
    return;
  }

  try {
    execFileSync('sudo', ['setfacl', '--restore=-'], {
      input: Buffer.from(originalAcl, 'base64').toString('utf8'),
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    console.log(`Restored the original ACL for ${KVM_DEVICE}.`);
  } catch (error) {
    console.log(`::warning::Failed to restore the original KVM ACL: ${error.message}`);
  }
}

main();
