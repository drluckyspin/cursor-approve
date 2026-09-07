# -----------------------------------------------------------------------------------------------------------
# cursor-approve Makefile
# -----------------------------------------------------------------------------------------------------------
# Cursor extension that approves pending agent tool calls by invoking Cursor's workbench commands.
#
# Usage:
#   make <target>
#
# Target descriptions live alongside their `.PHONY` declarations so `make help`
# can discover and present them automatically.
# -----------------------------------------------------------------------------------------------------------

# Open help when `make` is run without a target.
.DEFAULT_GOAL := help

# Use Bash for `source`, `PIPESTATUS`, and the shared logging helpers.
SHELL := /bin/bash

# Resolve paths from this Makefile so targets work from any current directory.
MAKEFILE_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
LOGGER := source "$(MAKEFILE_DIR)scripts/log.bash" &&
RESET := \033[0m
DIM := \033[2m

# Internal dependency checks stay out of `make help`.
check_deps:
	@$(MAKE) --no-print-directory check_node check_npm check_dprint check_cursor

# Verify required development tools and print their versions on success.
check_node:
	@if ! command -v node >/dev/null 2>&1; then \
		$(LOGGER) log_error "node is not installed. Install Node.js 20 or later."; \
		exit 1; \
	else \
		$(LOGGER) log_indent log_info_dim "$$(node --version)"; \
	fi

# npm is used by the package scripts and installation target.
check_npm:
	@if ! command -v npm >/dev/null 2>&1; then \
		$(LOGGER) log_error "npm is not installed. Install it with Node.js."; \
		exit 1; \
	else \
		$(LOGGER) log_indent log_info_dim "npm $$(npm --version)"; \
	fi

# dprint formats Markdown and TypeScript in this repository.
check_dprint:
	@if ! command -v dprint >/dev/null 2>&1; then \
		$(LOGGER) log_error "dprint is not installed. Install it from https://dprint.dev/install.sh"; \
		exit 1; \
	else \
		$(LOGGER) log_indent log_info_dim "$$(dprint --version)"; \
	fi

# The Cursor CLI is required for the README's local VSIX installation command.
check_cursor:
	@if ! command -v cursor >/dev/null 2>&1; then \
		$(LOGGER) log_error "Cursor CLI is not on PATH. In Cursor, run 'Shell Command: Install cursor command in PATH'."; \
		exit 1; \
	else \
		$(LOGGER) log_indent log_info_dim "$$(cursor --version 2>/dev/null | awk 'NR == 1 { print; exit }')"; \
	fi

# Print dynamically discovered public targets.
.PHONY: help ## Show this help message
help:
	@$(LOGGER) log_separator
	@$(LOGGER) log_banner
	@echo ""
	@$(LOGGER) log_info "Available make targets:"
	@echo ""
	@grep -E '^\.PHONY: .*## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ".PHONY: |## "}; {printf " %-22s$(RESET) $(DIM)- %s$(RESET)\n", $$2, $$3}'
	@echo ""

# Check all command-line dependencies before installing packages.
.PHONY: check ## Verify all developer dependencies
check:
	@$(LOGGER) log_target "Checking developer dependencies"
	@$(MAKE) --no-print-directory check_deps
	@$(LOGGER) log_success "All dependencies OK"

# Install JavaScript dependencies from package.json.
.PHONY: install ## Install npm dependencies
install: check
	@$(LOGGER) log_target "Installing npm dependencies"
	@set -o pipefail; $(LOGGER) log_run_dim npm install
	@$(LOGGER) log_success "Dependencies installed"

# Compile TypeScript into out/.
.PHONY: build ## Compile the TypeScript extension
build:
	@$(LOGGER) log_target "Compiling TypeScript"
	@set -o pipefail; $(LOGGER) log_run_dim npm run compile
	@$(LOGGER) log_success "Build complete"

# Run TypeScript without emitting files.
.PHONY: lint ## Run the TypeScript type check
lint:
	@$(LOGGER) log_target "Checking TypeScript"
	@set -o pipefail; $(LOGGER) log_run_dim npm run lint
	@$(LOGGER) log_success "Type check passed"

# Apply dprint formatting using this repository's dprint.json.
.PHONY: fmt ## Format Markdown and TypeScript with dprint
fmt:
	@$(LOGGER) log_target "Formatting repository"
	@set -o pipefail; $(LOGGER) log_run_dim dprint fmt --config "$(MAKEFILE_DIR)dprint.json"
	@$(LOGGER) log_success "Format complete"

# Verify formatting without modifying files.
.PHONY: fmt-check ## Check formatting without changing files
fmt-check:
	@$(LOGGER) log_target "Checking formatting"
	@set -o pipefail; $(LOGGER) log_run_dim dprint check --config "$(MAKEFILE_DIR)dprint.json"
	@$(LOGGER) log_success "Format check passed"

# Build first, then create the installable VSIX.
.PHONY: package ## Build the extension .vsix package
package: build
	@$(LOGGER) log_target "Packaging Cursor Approve"
	@set -o pipefail; $(LOGGER) log_run_dim npm run package
	@$(LOGGER) log_success "Package complete"

# Synchronize the VERSION file with files that expose the extension version.
.PHONY: bump-version ## Sync VERSION into package.json and README
bump-version:
	@$(LOGGER) log_target "Syncing version"
	@bash "$(MAKEFILE_DIR)scripts/bump-version.sh"
	@$(LOGGER) log_success "Version bump complete"

# Remove generated extension output and VSIX archives.
.PHONY: clean ## Remove build artifacts
clean:
	@$(LOGGER) log_target "Cleaning build artifacts"
	@rm -rf "$(MAKEFILE_DIR)out" "$(MAKEFILE_DIR)"*.vsix
	@$(LOGGER) log_success "Clean complete"
