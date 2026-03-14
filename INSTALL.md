# Install Zenith Bridge

This is the quickest setup guide for people who want to use `Zenith Bridge` with their own Obsidian vault.

## Option 1: Install with BRAT

This is the easiest option if the plugin is not yet in the official Obsidian community plugins directory.

1. In Obsidian, install the `BRAT` plugin from the community plugins browser.
2. Run the command `BRAT: Add a beta plugin for testing`.
3. Enter this repository URL:

```text
https://github.com/Chrisp671/obsidian-claude-code-mcp
```

4. Enable `Zenith Bridge` in `Settings -> Community Plugins`.
5. Use BRAT to install future updates from GitHub.

## Option 2: Manual install from a release

1. Open the latest release:

```text
https://github.com/Chrisp671/obsidian-claude-code-mcp/releases/latest
```

2. Download these files:
   - `manifest.json`
   - `main.js`
   - `styles.css`
3. In your vault, create this folder if it does not already exist:

```text
.obsidian/plugins/zenith-bridge/
```

4. Copy the three downloaded files into that folder.
5. In Obsidian, reload community plugins or restart the app.
6. Enable `Zenith Bridge` in `Settings -> Community Plugins`.

## Requirements

- Obsidian desktop
- Python 3.7+ recommended for the best terminal behavior
- If you want to launch Claude, Kimi, or Codex terminals, install the matching CLI and make sure it is on your shell `PATH`

## What this plugin does

- Opens AI agent terminals inside Obsidian
- Lets you create multiple terminal profiles
- Exposes your vault through MCP for compatible external clients
