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

const os = require('os');
const path = require('path');

/** Absolute path to the current user's .netrc file. */
const NETRC_PATH = path.join(os.homedir(), '.netrc');

/** Hostname used for the qnx.com netrc entry. */
const NETRC_MACHINE = 'qnx.com';

/**
 * Builds the netrc entry block that configures qnx.com credentials.
 * @param {string} username
 * @param {string} password
 * @returns {string}
 */
function buildNetrcEntry(username, password) {
  return `\nmachine ${NETRC_MACHINE}\n  login ${username}\n  password ${password}\n`;
}

/**
 * Regex that matches the netrc entry block written by buildNetrcEntry.
 * Designed to match the leading newline, the machine line, and the two indented sub-fields.
 */
const NETRC_ENTRY_REGEX = new RegExp(`\\nmachine ${NETRC_MACHINE}\\n[ \\t]+login [^\\n]*\\n[ \\t]+password [^\\n]*\\n`, 'g');

module.exports = { NETRC_PATH, NETRC_MACHINE, buildNetrcEntry, NETRC_ENTRY_REGEX };
