#!/usr/bin/env bash
set -euo pipefail

# -----------------------------------------------------------------------------------------------------------
# Script Name: generate-gif.sh
#
# Description: Convert a screen recording into an optimized animated GIF for the README or documentation.
#
# Usage:
#   SOURCE=/path/to/recording.mov [OUTPUT=docs/overview.gif] [WIDTH=900] [FPS=12] \
#     [START=0] [DURATION=] [CROP=width:height:x:y] scripts/generate-gif.sh
#
# Environment:
#   SOURCE    Required path to the input video.
#   OUTPUT    Destination GIF path. Defaults to docs/overview.gif.
#   WIDTH     Output width in pixels. Defaults to 900. Set to 0 to retain the source width.
#   FPS       Output frames per second. Defaults to 12.
#   START     Seconds to skip at the beginning. Defaults to 0.
#   DURATION  Optional number of seconds to include.
#   CROP      Optional FFmpeg crop expression, for example 630:430:2625:1715.
# -----------------------------------------------------------------------------------------------------------

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/log.bash
# shellcheck disable=SC1091
source "$ROOT/scripts/log.bash"

SOURCE="${SOURCE:-}"
OUTPUT="${OUTPUT:-$ROOT/docs/overview.gif}"
WIDTH="${WIDTH:-900}"
FPS="${FPS:-12}"
START="${START:-0}"
DURATION="${DURATION:-}"
CROP="${CROP:-}"

if [[ -z "$SOURCE" ]]; then
	log_error "SOURCE is required. Example: make gif SOURCE=/path/to/recording.mov"
	exit 1
fi

if [[ ! -f "$SOURCE" ]]; then
	log_error "Source video not found: $SOURCE"
	exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
	log_error "ffmpeg is not installed. Install it with Homebrew: brew install ffmpeg"
	exit 1
fi

if ! [[ "$WIDTH" =~ ^[0-9]+$ ]] || ! [[ "$FPS" =~ ^[0-9]+([.][0-9]+)?$ ]] ||
	! [[ "$START" =~ ^[0-9]+([.][0-9]+)?$ ]] ||
	[[ -n "$DURATION" && ! "$DURATION" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
	log_error "WIDTH must be a whole number; FPS, START, and DURATION must be non-negative numbers"
	exit 1
fi

if [[ -n "$CROP" && ! "$CROP" =~ ^[0-9]+:[0-9]+:[0-9]+:[0-9]+$ ]]; then
	log_error "CROP must use width:height:x:y, for example 630:430:2625:1715"
	exit 1
fi

filters=()
if [[ -n "$CROP" ]]; then
	filters+=("crop=$CROP")
fi
filters+=("fps=$FPS")
if [[ "$WIDTH" != "0" ]]; then
	filters+=("scale=$WIDTH:-1:flags=lanczos")
fi

filter="$(IFS=,; echo "${filters[*]}")"
palette_directory="$(mktemp -d -t cursor-approve-palette)"
palette="$palette_directory/palette.png"
trap 'rm -rf "$palette_directory"' EXIT

mkdir -p "$(dirname "$OUTPUT")"

input_args=()
if [[ "$START" != "0" ]]; then
	input_args+=("-ss" "$START")
fi
if [[ -n "$DURATION" ]]; then
	input_args+=("-t" "$DURATION")
fi

log_target "Generating $(basename "$OUTPUT")"
log_indent log_info_dim "Source: $SOURCE"
log_indent log_info_dim "Filter: $filter"

log_run_dim ffmpeg -hide_banner -y "${input_args[@]}" -i "$SOURCE" \
	-vf "$filter,palettegen=stats_mode=diff" -frames:v 1 -update 1 "$palette"
log_run_dim ffmpeg -hide_banner -y "${input_args[@]}" -i "$SOURCE" -i "$palette" \
	-lavfi "${filter}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" "$OUTPUT"

log_success "Created $OUTPUT"
