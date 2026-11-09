#!/usr/bin/env bash
# Install the Electron binary for this runner without using the
# github.com/.../releases/download URL that intermittently returns 504s.
#
# `npm ci` runs with ELECTRON_SKIP_BINARY_DOWNLOAD=1, so the `electron`
# package is present but has no dist/. This script fetches the same official
# artifact through the GitHub API (`gh release download`) and lays it out
# exactly as electron's own postinstall would:
#
#   node_modules/electron/dist/      unpacked Electron
#   node_modules/electron/path.txt  executable relative to dist/
#
# Usage: scripts/install-electron-from-release.sh <mac-arm64|windows-x64|linux-x64>

set -euo pipefail

platform="${1:?usage: install-electron-from-release.sh <mac-arm64|windows-x64|linux-x64>}"

case "$platform" in
	mac-arm64) artifact_platform="darwin-arm64"; electron_path="Electron.app/Contents/MacOS/Electron" ;;
	windows-x64) artifact_platform="win32-x64"; electron_path="electron.exe" ;;
	linux-x64) artifact_platform="linux-x64"; electron_path="electron" ;;
	*) echo "unsupported platform: $platform" >&2; exit 1 ;;
esac

version="$(node -p "require('electron/package.json').version")"
artifact="electron-v${version}-${artifact_platform}.zip"
zip="$RUNNER_TEMP/electron.zip"

rm -f "$zip"
for attempt in 1 2 3 4 5; do
	if gh release download "v${version}" --repo electron/electron --pattern "$artifact" --output "$zip" --clobber; then
		break
	fi
	if [[ "$attempt" == 5 ]]; then
		echo "could not download $artifact after 5 attempts" >&2
		exit 1
	fi
	echo "download failed (attempt $attempt); retrying in $((attempt * 10))s" >&2
	sleep $((attempt * 10))
done

rm -rf node_modules/electron/dist
mkdir -p node_modules/electron/dist

case "$RUNNER_OS" in
	Windows)
		if command -v 7z >/dev/null 2>&1; then
			7z x -y "$zip" -o"node_modules/electron/dist" >/dev/null
		else
			"/c/Program Files/7-Zip/7z.exe" x -y "$zip" -o"node_modules/electron/dist" >/dev/null
		fi
		;;
	*)
		unzip -q "$zip" -d node_modules/electron/dist
		;;
esac

printf '%s' "$electron_path" > node_modules/electron/path.txt
echo "electron ${version} (${artifact_platform}) installed from the GitHub API"
