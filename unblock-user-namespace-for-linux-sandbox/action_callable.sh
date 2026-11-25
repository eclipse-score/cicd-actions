#!/bin/bash
# *******************************************************************************
# Copyright (c) 2026 Contributors to the Eclipse Foundation
#
# See the NOTICE file(s) distributed with this work for additional
# information regarding copyright ownership.
#
# This program and the accompanying materials are made available under the
# terms of the Apache License Version 2.0 which is available at
# https://www.apache.org/licenses/LICENSE-2.0
#
# SPDX-License-Identifier: Apache-2.0
# *******************************************************************************
set -euo pipefail

if ! command -v bazel >/dev/null 2>&1; then
  echo "ERROR: bazel is required for this action"
  exit 1
fi

INSTALL_BASE=$(bazel info install_base)
sudo bash -c "cat >/etc/apparmor.d/score-linux-sandbox" <<-EOF
abi <abi/4.0>,
include <tunables/global>

profile linux-sandbox ${INSTALL_BASE}/linux-sandbox flags=(unconfined) {
  userns,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/score-linux-sandbox>
}
EOF
# Loading an AppArmor profile is a kernel operation that is impossible inside a
# container (e.g. Kubernetes-hosted self-hosted runners). On such runners the
# host must already permit unprivileged user namespaces (e.g.
# kernel.apparmor_restrict_unprivileged_userns=0), making the profile
# unnecessary. Warn instead of failing, and let the functional check below
# decide whether linux-sandbox actually works.
if ! sudo apparmor_parser -r /etc/apparmor.d/score-linux-sandbox; then
  echo "WARNING: could not load the AppArmor profile (no AppArmor kernel access," \
       "e.g. running inside a container); relying on the host configuration."
fi

set +e
"${INSTALL_BASE}/linux-sandbox" "/bin/true"
EXIT_CODE=$?
set -e
if [ $EXIT_CODE -ne 0 ]; then
  echo "Error: '${INSTALL_BASE}/linux-sandbox /bin/true' failed."
else
  echo "Success: '${INSTALL_BASE}/linux-sandbox /bin/true' succeeded."
fi
exit $EXIT_CODE
