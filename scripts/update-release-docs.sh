#!/usr/bin/env bash
set -euo pipefail

# -----------------------------------------------------------------------------------------------------------
# Script Name: update-release-docs.sh
#
# Description: Finalize CHANGELOG after a GitHub release is published.
#
# Usage:
#   scripts/update-release-docs.sh VERSION YYYY-MM-DD
#
# Environment:
#   RELEASE_BODY  Optional GitHub release notes body. Used only when CHANGELOG has no [Unreleased] section
#                 and no existing section for VERSION.
# -----------------------------------------------------------------------------------------------------------

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/log.bash
# shellcheck disable=SC1091
source "$ROOT/scripts/log.bash"

CHANGELOG="$ROOT/CHANGELOG.md"

if (( $# != 2 )); then
	log_error "Usage: scripts/update-release-docs.sh VERSION YYYY-MM-DD"
	exit 1
fi

VERSION="${1#v}"
RELEASE_DATE="$2"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
	log_error "VERSION must be a semantic version (for example, 0.3.1)"
	exit 1
fi

if [[ ! "$RELEASE_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
	log_error "RELEASE_DATE must be YYYY-MM-DD"
	exit 1
fi

if [[ ! -f "$CHANGELOG" ]]; then
	log_error "CHANGELOG.md not found"
	exit 1
fi

log_target "Updating release documentation for v$VERSION"

changelog_updated=false

if grep -qE "^## \\[$VERSION\\]" "$CHANGELOG"; then
	log_indent log_info_dim "CHANGELOG already documents v$VERSION"
elif grep -qE '^## \[Unreleased\]' "$CHANGELOG"; then
	log_indent log_info_dim "Finalizing CHANGELOG [Unreleased] as v$VERSION"
	sed -i.bak -E "s/^## \\[Unreleased\\]/## [$VERSION] - $RELEASE_DATE/" "$CHANGELOG"
	rm -f "$CHANGELOG.bak"

	# Keep a blank [Unreleased] section ready for the next development cycle.
	awk '
		/^\[Semantic Versioning\]/ {
			print
			print ""
			print "## [Unreleased]"
			print ""
			next
		}
		{ print }
	' "$CHANGELOG" > "$CHANGELOG.tmp"
	mv "$CHANGELOG.tmp" "$CHANGELOG"
	changelog_updated=true
	log_indent log_success "Finalized CHANGELOG for v$VERSION"
elif [[ -n "${RELEASE_BODY:-}" ]]; then
	log_indent log_info_dim "Adding CHANGELOG section for v$VERSION from release notes"
	{
		head -n 6 "$CHANGELOG"
		echo ""
		echo "## [$VERSION] - $RELEASE_DATE"
		echo ""
		printf '%s\n' "$RELEASE_BODY"
		echo ""
		tail -n +7 "$CHANGELOG"
	} > "$CHANGELOG.tmp"
	mv "$CHANGELOG.tmp" "$CHANGELOG"
	changelog_updated=true
	log_indent log_success "Added CHANGELOG section for v$VERSION"
else
	log_indent log_warning "No [Unreleased] section or release body; skipping CHANGELOG update"
fi

if [[ "$changelog_updated" == false ]]; then
	log_success "Release documentation already up to date"
else
	log_success "CHANGELOG updated for v$VERSION"
fi
