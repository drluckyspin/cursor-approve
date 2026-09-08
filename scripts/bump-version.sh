#!/usr/bin/env bash
set -euo pipefail

# -----------------------------------------------------------------------------------------------------------
# Script Name: bump-version.sh
#
# Description: Synchronize a semantic version into VERSION, package.json, and README VSIX examples.
#
# Usage:
#   make bump-version X.Y.Z
#   make bump-version            # reuse the version already in VERSION
# -----------------------------------------------------------------------------------------------------------

# Resolve the repository root from this script's location and load shared logging.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/log.bash
# shellcheck disable=SC1091 # ROOT is dynamic; use shellcheck -x to follow this source file.
source "$ROOT/scripts/log.bash"

# Accept at most one optional version argument.
if (( $# > 1 )); then
	log_error "Usage: make bump-version [X.Y.Z]"
	exit 1
fi

# Prefer an explicit version argument; otherwise reuse the current VERSION file.
if (( $# == 1 )); then
	VERSION="${1#v}"
elif [[ ! -f "$ROOT/VERSION" ]]; then
	log_error "VERSION file not found"
	exit 1
else
	VERSION="$(tr -d ' \n\r' < "$ROOT/VERSION")"
	VERSION="${VERSION#v}"
fi

# Require a semantic version before updating any files.
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
	log_error "VERSION must be a semantic version (for example, 0.2.0)"
	exit 1
fi

log_indent log_info_dim "Setting version to $VERSION"

# VERSION is the repository's canonical version source.
printf "%s\n" "$VERSION" > "$ROOT/VERSION"
log_indent log_success "Updated VERSION"

# Keep the extension manifest aligned with the canonical version.
sed -i.bak -E "s/\"version\": \"[^\"]+\"/\"version\": \"$VERSION\"/" "$ROOT/package.json"
rm -f "$ROOT/package.json.bak"
log_indent log_success "Updated package.json"

# Update versioned local-install examples in the README.
sed -i.bak -E "s/cursor-approve-[0-9]+\\.[0-9]+\\.[0-9]+([-.][0-9A-Za-z.-]+)?\\.vsix/cursor-approve-$VERSION.vsix/g" \
	"$ROOT/README.md"
rm -f "$ROOT/README.md.bak"
log_indent log_success "Updated README.md install examples"
