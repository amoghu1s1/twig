#!/usr/bin/env bash
# Run electron-builder with bounded retries. GitHub's release download
# service intermittently returns 504s for the toolchain archives
# (7zip/dmgbuild/AppImage helpers) even when the build itself is fine.
# Retrying keeps a release moving through that outage; a real build error
# still fails after the final attempt.

set -euo pipefail

for attempt in 1 2 3; do
	if npx electron-builder "$@"; then
		exit 0
	fi
	if [[ "$attempt" == 3 ]]; then
		exit 1
	fi
	echo "electron-builder failed (attempt $attempt); retrying in 30s" >&2
	sleep 30
done
