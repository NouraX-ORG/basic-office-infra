#!/usr/bin/env bash
# The server test of the privacy switch under the name Task 6b's plan gave it: it runs
# tests/org-privacy-switch.sh (docs/teams.md#the-switch), with privacy on, switching nothing off.
#
#   sudo tests/privacy-switch.sh
#
# Not inside flock: the test takes the server-change lock itself (or set NOURAX_LOCK_HELD=1 when
# you hold it already). Exit 0 when every check passes.
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail
exec bash "$(dirname "$0")/org-privacy-switch.sh" "$@"
