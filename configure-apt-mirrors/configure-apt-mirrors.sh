#!/usr/bin/env bash
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

readonly sources_file=/etc/apt/sources.list.d/ubuntu.sources
readonly mirror_list_file=/etc/apt/apt-mirrors.txt
readonly apt_retries_file=/etc/apt/apt.conf.d/80-acquire-retries

if [[ ! -r /etc/os-release ]]; then
  echo "ERROR: /etc/os-release is unavailable; this action requires Ubuntu."
  exit 1
fi

source /etc/os-release
if [[ "${ID:-}" != ubuntu ]]; then
  echo "ERROR: This action requires Ubuntu; detected '${ID:-unknown}'."
  exit 1
fi

if [[ ! -f "$sources_file" ]]; then
  echo "ERROR: Ubuntu Deb822 sources file not found: $sources_file"
  exit 1
fi

if [[ ! "$APT_RETRIES" =~ ^[0-9]+$ ]]; then
  echo "ERROR: retries must be a non-negative integer; got '$APT_RETRIES'."
  exit 1
fi

mirror_urls=()
while IFS= read -r mirror_url; do
  [[ "$mirror_url" =~ ^[[:space:]]*$ ]] && continue
  [[ "$mirror_url" =~ ^[[:space:]]*# ]] && continue

  if [[ "$mirror_url" =~ [[:space:]] || ! "$mirror_url" =~ ^https?://[^/[:space:]]+(/[^[:space:]]*)?$ ]]; then
    echo "ERROR: Invalid mirror URL: '$mirror_url'"
    exit 1
  fi

  mirror_urls+=("$mirror_url")
done <<< "$APT_MIRRORS_INPUT"

if [[ ${#mirror_urls[@]} -eq 0 ]]; then
  echo "ERROR: At least one Ubuntu mirror URL must be provided."
  exit 1
fi

if ! grep -q '^URIs:' "$sources_file"; then
  echo "ERROR: No Deb822 URI entries found in $sources_file."
  exit 1
fi

{
  priority=1
  for mirror_url in "${mirror_urls[@]}"; do
    printf '%s\tpriority:%s\n' "$mirror_url" "$priority"
    priority=$((priority + 1))
  done
} | sudo tee "$mirror_list_file" >/dev/null
sudo chmod 644 "$mirror_list_file"
sudo -u _apt test -r "$mirror_list_file"

sudo sed -i -E "s|^URIs:.*$|URIs: mirror+file:$mirror_list_file|" "$sources_file"
if ! grep -Fq "URIs: mirror+file:$mirror_list_file" "$sources_file"; then
  echo "ERROR: Failed to configure the Ubuntu source URI in $sources_file."
  exit 1
fi

printf 'Acquire::Retries "%s";\n' "$APT_RETRIES" |
  sudo tee "$apt_retries_file" >/dev/null

echo "Configured Ubuntu APT mirror list at $mirror_list_file:"
cat "$mirror_list_file"
echo "APT retry count: $APT_RETRIES"
