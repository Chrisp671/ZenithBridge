#!/bin/bash

# Install script for the Chrisp671 fork of the Obsidian Claude Code MCP plugin
# Copies built plugin files to an Obsidian vault's plugins directory

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Usage information
usage() {
    echo "Usage: $0 [VAULT_PATH]"
    echo ""
    echo "Install the Chrisp671 fork of the Claude Code MCP plugin into an Obsidian vault."
    echo ""
    echo "Arguments:"
    echo "  VAULT_PATH    Path to your Obsidian vault (the folder containing .obsidian/)"
    echo "                Defaults to the current directory if not provided."
    echo ""
    echo "Examples:"
    echo "  $0 ~/my-vault"
    echo "  $0 /path/to/obsidian/vault"
    echo "  cd /path/to/vault && $0"
}

if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
    usage
    exit 0
fi

# Determine vault path: use argument if provided, otherwise current directory
VAULT_PATH="${1:-.}"

# Resolve to absolute path
VAULT_PATH="$(cd "$VAULT_PATH" 2>/dev/null && pwd)"
if [ $? -ne 0 ]; then
    echo -e "${RED}Error: Directory '$1' does not exist.${NC}"
    exit 1
fi

# Validate that this looks like an Obsidian vault
PLUGINS_DIR="$VAULT_PATH/.obsidian/plugins"
if [ ! -d "$VAULT_PATH/.obsidian" ]; then
    echo -e "${RED}Error: '$VAULT_PATH' does not appear to be an Obsidian vault.${NC}"
    echo -e "${RED}No .obsidian/ directory found.${NC}"
    echo ""
    usage
    exit 1
fi

# Target directory for the plugin
TARGET_DIR="$PLUGINS_DIR/claude-code-mcp-chrisp671"

# Required files (should be in the same directory as this script)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REQUIRED_FILES=("main.js" "manifest.json" "styles.css")

# Check if all required files exist
echo "Checking for required files in $SCRIPT_DIR..."
for file in "${REQUIRED_FILES[@]}"; do
    if [ ! -f "$SCRIPT_DIR/$file" ]; then
        echo -e "${RED}Error: $file not found in $SCRIPT_DIR. Please run 'bun run build' first.${NC}"
        exit 1
    fi
done

# Create target directory if it doesn't exist
mkdir -p "$PLUGINS_DIR" 2>/dev/null
mkdir -p "$TARGET_DIR"

# Copy files
echo "Installing plugin to $TARGET_DIR..."
for file in "${REQUIRED_FILES[@]}"; do
    cp "$SCRIPT_DIR/$file" "$TARGET_DIR/"
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}  Copied $file${NC}"
    else
        echo -e "${RED}  Failed to copy $file${NC}"
        exit 1
    fi
done

echo ""
echo -e "${GREEN}Plugin installed successfully to $TARGET_DIR${NC}"
echo -e "${YELLOW}You may need to reload Obsidian or enable the plugin in Settings > Community plugins.${NC}"
