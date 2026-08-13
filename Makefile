.PHONY: install build test bridge clean help

# Only targets that drive the CURRENT architecture. This file used to carry `dev`, `playwright-mcp`,
# `chrome-debug`, `start-local` and the docker targets — all of them the pre-bridge design, which
# attached the official Playwright MCP to a debug Chrome over CDP and tunnelled INTO your machine.
# `make help` was therefore a list of ways to start something that no longer exists.

install:
	npm install

build: install
	npm run build

test:
	npm test

# The bridge, with tokens you must already have exported. See README "Quick start".
bridge:
	@[ -n "$$BRIDGE_ACCESS_TOKEN" ] || { echo "set BRIDGE_ACCESS_TOKEN (openssl rand -hex 32)"; exit 1; }
	@[ -n "$$BRIDGE_MCP_TOKEN" ]    || { echo "set BRIDGE_MCP_TOKEN (openssl rand -hex 32)"; exit 1; }
	node packages/bridge-server/dist/index.js

clean:
	rm -rf packages/*/dist node_modules packages/*/node_modules

help:
	@echo ""
	@echo "Remote Browser MCP"
	@echo "------------------"
	@echo "  make install   Install dependencies"
	@echo "  make build     Build all packages"
	@echo "  make bridge    Run the bridge (needs BRIDGE_ACCESS_TOKEN + BRIDGE_MCP_TOKEN)"
	@echo "  make test      Run the full suite"
	@echo "  make clean     Remove build artifacts"
	@echo ""
