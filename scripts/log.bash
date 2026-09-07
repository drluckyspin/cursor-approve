#!/usr/bin/env bash

# -----------------------------------------------------------------------------------------------------------
# Script Name: log.bash
#
# Description: Shared logging utilities for project scripts that provide colored and formatted console output.
#
# Functions:
#   get_terminal_width : Get current terminal width (max 120 chars)
#   log                : Basic white text logging
#   log_dim            : Dimmed white text logging
#   log_info           : Blue text for info messages
#   log_info_dim       : Dimmed blue text for info messages
#   log_success        : Green checkmark with dimmed green text for success messages
#   log_error          : Red X symbol with dimmed red text for error messages
#   log_warning        : Yellow triangle with dimmed yellow text for warnings
#   log_indent         : Indent (2 spaces) and call any log function
#   log_pipe_dim       : Stream stdin with 2-space indent and dim styling
#   log_run_dim        : Run a command; pipe combined stdout/stderr through log_pipe_dim
#   log_separator      : Print a separator line across terminal width
#   log_target         : Separator + title (once per make target)
#   log_section        : Blank line + section title (between chunks within a target)
#   log_centered       : Print centered text
#   log_verbose        : Log message only if VERBOSE=true
#   log_banner         : Display the Cursor Approve ASCII banner
# -----------------------------------------------------------------------------------------------------------
# Usage: source scripts/log.bash
# -----------------------------------------------------------------------------------------------------------

# Global variables
: "${VERBOSE:=false}"

# ANSI color codes
RED='\033[91m'
GREEN='\033[92m'
YELLOW='\033[93m'
BLUE='\033[94m'
WHITE='\033[97m'
PURPLE='\033[95m'
RESET='\033[0m'
DIM='\033[2m'

# Get current terminal width, capped at 120 columns.
get_terminal_width() {
	local width
	width="$(tput cols 2>/dev/null || echo 80)"
	if [[ -z "$width" || "$width" -le 0 ]]; then
		width=80
	elif [ "$width" -gt 120 ]; then
		width=120
	fi
	echo "$width"
}

# Basic logging functions for consistent console output.
log() {
	echo -e "${WHITE} $1${RESET}"
}

log_dim() {
	echo -e "${DIM}${WHITE} $1${RESET}"
}

log_info() {
	echo -e "${BLUE} $1${RESET}"
}

log_info_dim() {
	echo -e "${DIM}${BLUE} $1${RESET}"
}

log_success() {
	echo -e " ${GREEN}✔${RESET} ${DIM}${GREEN} $1${RESET}"
}

log_error() {
	echo -e " ${RED}🅇${RESET}  ${DIM}${RED}$1${RESET}"
}

log_warning() {
	echo -e " ${YELLOW}▲${RESET}  ${DIM}${YELLOW}$1${RESET}"
}

# Print a separator line across terminal width.
log_separator() {
	local terminal_width
	terminal_width=$(get_terminal_width)
	printf "=-%.0s" $(seq 1 $((terminal_width / 2)))
	echo "="
}

# Open a make target: separator, blank line, then title.
log_target() {
	log_separator
	echo ""
	log_info "$1"
}

# Start a section within a target: blank line, then title.
log_section() {
	echo ""
	log_info "$1"
}

# Indent output and call another logging function.
log_indent() {
	local log_func=$1
	shift
	printf "  "
	$log_func "$@"
}

# Stream standard input with indentation and dim styling.
log_pipe_dim() {
	while IFS= read -r line || [ -n "$line" ]; do
		printf "  ${DIM}${WHITE}%s${RESET}\n" "$line"
	done
}

# Run a command, dim its combined output, and preserve its exit status.
log_run_dim() {
	"$@" 2>&1 | log_pipe_dim
	return "${PIPESTATUS[0]}"
}

# Center a message in the terminal.
log_centered() {
	local terminal_width
	local message="$1"
	terminal_width=$(get_terminal_width)

	local padding=$(((terminal_width - ${#message}) / 2))
	local pad_str
	pad_str=$(printf '%*s' "$padding" '')

	echo -e "${pad_str}${message}"
}

# Print only when VERBOSE=true.
log_verbose() {
	if [[ "${VERBOSE:-false}" == "true" ]]; then
		log_info_dim "$*"
	fi
}

# Display the project banner in the configured accent color.
log_banner() {
	printf '%b' "$PURPLE"
	cat <<'EOF'
  ___  _  _  ____  ____   __  ____     __   ____  ____  ____   __   _  _  ____
 / __)/ )( \(  _ \/ ___) /  \(  _ \   / _\ (  _ \(  _ \(  _ \ /  \ / )( \(  __)
( (__ ) \/ ( )   /\___ \(  O ))   /  /    \ ) __/ ) __/ )   /(  O )\ \/ / ) _)
 \___)\____/(__\_)(____/ \__/(__\_)  \_/\_/(__)  (__)  (__\_) \__/  \__/ (____)
EOF
	printf '%b\n' "$RESET"
}

# Example usage when this file is executed directly.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
	log_separator
	log_banner
	log "This is a normal message."
	log_dim "This is a dim message."
	log_info "This is an info message."
	log_info_dim "This is a dim info message."
	log_success "This is a success message."
	log_warning "This is a warning message."
	log_error "This is an error message."
	log_indent log_success "This is an indented message."
	log_centered "This is a centered message"
	log_separator
fi
