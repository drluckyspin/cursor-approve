#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/log.bash
source "$ROOT/scripts/log.bash"

if [[ ! -f "$ROOT/VERSION" ]]; then
	log_error "VERSION file not found"
	exit 1
fi

VERSION="$(tr -d ' \n\r' < "$ROOT/VERSION")"
VERSION="${VERSION#v}"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
	log_error "VERSION must be a semantic version (for example, 0.2.0)"
	exit 1
fi

log_indent log_info_dim "Setting version to $VERSION"

sed -i.bak -E "s/\"version\": \"[^\"]+\"/\"version\": \"$VERSION\"/" "$ROOT/package.json"
rm -f "$ROOT/package.json.bak"
log_indent log_success "Updated package.json"

sed -i.bak -E "s/cursor-approve-[0-9]+\\.[0-9]+\\.[0-9]+([-.][0-9A-Za-z.-]+)?\\.vsix/cursor-approve-$VERSION.vsix/g" \
	"$ROOT/README.md"
rm -f "$ROOT/README.md.bak"
log_indent log_success "Updated README.md install examples"
