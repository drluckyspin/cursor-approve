#!/usr/bin/env bash
set -euo pipefail

# -----------------------------------------------------------------------------------------------------------
# Script Name: generate-screenshots.sh
#
# Description: Regenerate the README's dashboard screenshots and approval GIF from the current build, by
#              running Cursor Approve in a throwaway, signed-out instance of the installed Cursor. See
#              scripts/screenshots/capture.mjs for how the instance is isolated and why nothing captures the
#              screen.
#
# Usage:
#   [THEME="City Fog"] [CURSOR_APP=/path/to/Cursor] [KEEP_PROFILE=true] scripts/generate-screenshots.sh
#
# Environment:
#   THEME         Color theme label. Defaults to "City Fog"; falls back to Default Dark Modern when absent.
#   CURSOR_APP    Cursor's executable. Defaults to /Applications/Cursor.app/Contents/MacOS/Cursor.
#   KEEP_PROFILE  "true" keeps the temporary profile, logs, and GIF frames for inspection.
# -----------------------------------------------------------------------------------------------------------

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/log.bash
# shellcheck disable=SC1091
source "$ROOT/scripts/log.bash"

if ! command -v ffmpeg >/dev/null 2>&1; then
	log_error "ffmpeg is not installed. Install it with Homebrew: brew install ffmpeg"
	exit 1
fi

if [[ ! -f "$ROOT/out/extension.js" ]]; then
	log_error "out/extension.js is missing. Run make build first."
	exit 1
fi

log_indent log_info_dim "A Cursor window opens for about 30 seconds. It ignores the mouse, but do not type into it or"
log_indent log_info_dim "minimize it until it closes."

log_run_dim node "$ROOT/scripts/screenshots/capture.mjs"
