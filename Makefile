LSP_INSTALL_DIR ?= $(HOME)/.bun/bin
ZED_EXTENSION_INSTALL_DIR ?= $(HOME)/Library/Application Support/Zed/extensions/installed
ZED_EXTENSION_ID ?= dream-lang
ZED_EXTENSION_PACKAGE ?= zed/dist/dream-lang.tar.gz
ZED_GIT_SSH_PREFIX ?= git@github.com:weaming/
ZED_GIT_HTTPS_PREFIX ?= https://github.com/weaming/

.PHONY: lsp-build install install-lsp install-lsp-server install-lsp-mcp install-zed-extension

lsp-build:
	cd lsp && bun install --frozen-lockfile && bun run build

install: install-lsp

install-lsp: install-lsp-server install-lsp-mcp

install-lsp-server: lsp-build
	mkdir -p "$(LSP_INSTALL_DIR)"
	install -m 755 lsp/dist/dream-language-server "$(LSP_INSTALL_DIR)/dream-language-server"

install-lsp-mcp: lsp-build
	mkdir -p "$(LSP_INSTALL_DIR)"
	install -m 755 lsp/dist/dream-lsp-mcp "$(LSP_INSTALL_DIR)/dream-lsp-mcp"

install-zed-extension:
	GIT_CONFIG_COUNT=1 \
	GIT_CONFIG_KEY_0="url.$(ZED_GIT_SSH_PREFIX).insteadOf" \
	GIT_CONFIG_VALUE_0="$(ZED_GIT_HTTPS_PREFIX)" \
	./zed/package.fish
	mkdir -p "$(dir $(ZED_EXTENSION_PACKAGE))"
	cp zed/dist/archive.tar.gz "$(ZED_EXTENSION_PACKAGE)"
	mkdir -p "$(ZED_EXTENSION_INSTALL_DIR)/$(ZED_EXTENSION_ID)"
	tar -xzf "$(ZED_EXTENSION_PACKAGE)" -C "$(ZED_EXTENSION_INSTALL_DIR)/$(ZED_EXTENSION_ID)"
