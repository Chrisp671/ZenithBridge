# Obsidian Agent Terminal MCP

An Obsidian plugin that embeds AI agent terminals in your vault and provides an MCP (Model Context Protocol) server for Claude Code and other compatible external clients.

This repository is the `Chrisp671` fork of the original project by `iansinnott`. The fork uses its own plugin id, `claude-code-mcp-chrisp671`, so it can be distributed without colliding with upstream installs.

## Attribution

This fork is maintained by `Chrisp671`.

Workflow and template inspiration for this setup come from Rich Schefren, the Zenith program, and Strategic Profits. Credit for that influence belongs to them.

This project is not presented as an official Rich Schefren, Zenith, or Strategic Profits product, and no affiliation or endorsement is implied.

## Features
-   **Embedded Terminal**: Run Claude Code inside Obsidian with full PTY support (Ctrl+` or command palette)
-   **Multiple Terminal Sessions**: Open several agent terminals at once using native Obsidian panes
-   **Terminal Profiles**: Use a default Claude preset or create custom profiles for tools like Kimi or Codex
-   **Windows ConPTY**: Real pseudo-terminal on Windows via Python's `pywinpty`
-   **Unix PTY**: Native pseudo-terminal on macOS/Linux via Python's `pty` stdlib module
-   **Fallback Mode**: Basic `child_process` terminal if Python is not available
-   **Dual Transport MCP Server**: WebSocket (for Claude Code CLI) and HTTP/SSE (for Claude Desktop)
-   **Auto-Discovery**: Lock files with `authToken` written to both `~/.config/claude/ide/` and `~/.claude/ide/`
-   **File Operations**: Read and write vault files through MCP protocol
-   **Workspace Context**: Provides current active file and vault structure to Claude
-   **Multiple Client Support**: Connect Claude Code, Claude Desktop, and the embedded terminal simultaneously

## Setup / Requirements

### All Platforms

-   **Obsidian** v1.4.0+
-   **Python 3.7+** (optional but recommended for full terminal support)

Without Python, the embedded terminal falls back to a basic `child_process` mode that lacks true PTY capabilities (no interactive TUI apps, no proper resize handling).

### Windows

Install `pywinpty` for ConPTY support:

```
pip install pywinpty
```

### macOS / Linux

No extra packages needed. The terminal uses Python's built-in `pty` and `selectors` modules from the standard library.

## Embedded Terminal

The plugin includes a built-in terminal that runs directly inside Obsidian.

**Opening the terminal:**

-   Press `Ctrl+`` (backtick)
-   Or use the command palette: "Open or Focus Default Terminal"
-   Or use the command palette: "New Agent Terminal..."
-   Or click the Claude icon in the ribbon sidebar

Each session launches your platform's default shell (PowerShell on Windows, `$SHELL` on Unix) with the working directory set to your vault root. The selected terminal profile then runs its launch command automatically. The built-in default profile is `Claude`, and you can add custom profiles for other tools later.

**PTY mode selection** (automatic):

| Platform | Python available | pywinpty installed | Mode used |
|---|---|---|---|
| Windows | Yes | Yes | ConPTY via pywinpty |
| Windows | Yes | No | Fallback (child_process) |
| Windows | No | - | Fallback (child_process) |
| macOS/Linux | Yes | - | Unix PTY via stdlib |
| macOS/Linux | No | - | Fallback (child_process) |

## MCP Client Configuration

This plugin serves as an MCP server that various Claude clients can connect to. Here's how to configure different clients:

### Claude Desktop (as of 2025-06-09)

Claude Desktop requires a special configuration to connect to the Obsidian MCP server because it does not directly support HTTP transports. We will use `mcp-remote`, a tool that creates a local `stdio` bridge to the server's HTTP endpoint.

**Configuration Steps:**

1.  **Install and enable** this plugin in Obsidian.
2.  **Make sure you have Node.js installed**, as `npx` (which comes with Node.js) is used to run the bridge tool.
3.  **Locate your Claude Desktop config file**:
    -   **macOS**: `$HOME/Library/Application Support/Claude/claude_desktop_config.json`
    -   **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
4.  **Add the Obsidian MCP server** to your config using the `mcp-remote` command. `npx` will automatically download and run it for you.

    ```json
    {
    	"mcpServers": {
    		"obsidian": {
    			"command": "npx",
    			"args": ["mcp-remote", "http://localhost:22360/sse"],
    			"env": {}
    		}
    	}
    }
    ```

5.  **Restart Claude Desktop** after making the configuration change.
6.  **Test the connection** by asking Claude about your vault: "What files are in my Obsidian vault?"

### Other MCP Clients (with direct HTTP support)

If you are using an MCP client that directly supports the legacy "HTTP with SSE" transport, you can use a simpler configuration without the `mcp-remote` bridge.

**Example Configuration:**

```json
{
	"mcpServers": {
		"obsidian": {
			"url": "http://localhost:22360/sse",
			"env": {}
		}
	}
}
```

### Claude Code CLI

Claude Code automatically discovers and connects to Obsidian vaults through WebSocket.

**Usage Steps:**

1. **Install and enable** this plugin in Obsidian
2. **Run Claude Code** in your terminal: `claude`
3. **Select your vault** using the `/ide` command
4. **Choose "Obsidian"** from the IDE list
5. Claude Code will automatically connect via WebSocket

### Port Configuration

**Default Port**: The plugin uses port `22360` by default to avoid conflicts with common development services.

**Custom Port Setup:**

1.  Go to **Obsidian Settings** > **Community Plugins** > **Obsidian Agent Terminal MCP** > **Settings**
2.  Change the **"HTTP Server Port"** in the MCP Server Configuration section
3.  **Update your Claude Desktop config** to use the new port:
    ```json
    {
    	"mcpServers": {
    		"obsidian": {
    			"url": "http://localhost:22360/mcp",
    			"env": {}
    		}
    	}
    }
    ```
        NOTE: You can change the port in the settings.
4.  **Restart Claude Desktop** to apply the changes

**Multiple Vaults**: If you run multiple Obsidian vaults with this plugin, each vault needs a unique port. The plugin will automatically detect port conflicts and guide you to configure different ports.

### A Note on MCP Specification Version

_As of 2025-06-09_

> [!IMPORTANT]
> This plugin intentionally uses an older MCP specification for HTTP transport. The latest ["Streamable HTTP" protocol (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) is not yet supported by most MCP clients, including Claude Code and Claude Desktop.
>
> To ensure compatibility, we use the legacy ["HTTP with SSE" protocol (2024-11-05)](https://modelcontextprotocol.io/specification/2024-11-05/basic/transports#http-with-sse). Adhering to the newest specification will lead to connection failures with current tools.

## Configuration

Plugin settings are available under **Obsidian Settings** > **Community Plugins** > **Obsidian Agent Terminal MCP**.

### MCP Server Configuration

| Setting | Default | Description |
|---|---|---|
| Enable WebSocket Server | On | WebSocket server for Claude Code CLI auto-discovery via lock files |
| Enable HTTP/SSE Server | On | HTTP/SSE server for Claude Desktop and other MCP clients |
| HTTP Server Port | 22360 | Port for the HTTP/SSE MCP server (1024-65535) |

### Terminal Configuration

| Setting | Default | Description |
|---|---|---|
| Enable Embedded Terminal | On | Enable/disable the built-in terminal. Requires plugin reload. |
| Auto-close terminal on shell exit | On | Close the terminal view when the shell process exits |
| Max terminal sessions | `4` | Maximum number of concurrent embedded terminal sessions |
| Default terminal profile | `Claude` | Profile used by the ribbon button and default terminal command |
| Terminal profiles | Built-in Claude preset + custom profiles | Launch commands and environment variables for each terminal profile |

## Troubleshooting

### Terminal Issues

**Terminal not starting / "No suitable Python installation found"**
-   Install Python 3.7+ and ensure it is on your `PATH`
-   Windows: `python --version` should print `Python 3.x.x` (not open the Microsoft Store)
-   macOS: `python3 --version` should work. If not, install via Homebrew: `brew install python`

**"pywinpty not installed" (Windows only)**
-   Run `pip install pywinpty` in your terminal
-   If you use multiple Python installations, install it for the one on your `PATH`

**Terminal falls back to basic mode**
-   Python was not found, or dependency checks failed
-   Check the Obsidian developer console (Ctrl+Shift+I) for `[Terminal]` log messages
-   On Windows, verify pywinpty: `python -c "from winpty import PtyProcess; print('OK')"`
-   On macOS/Linux, verify pty: `python3 -c "import pty, selectors; print('OK')"`

**Interactive apps (vim, htop, etc.) not working**
-   These require a real PTY. Make sure Python is installed so the plugin uses PTY mode instead of fallback mode.

### MCP Connection Issues

**Claude Desktop not connecting:**

-   Verify the config file path and JSON syntax
-   Ensure Obsidian is running with the plugin enabled
-   Check that the port (22360) isn't blocked by firewall
-   Restart Claude Desktop after config changes

**Claude Code not finding vault:**

-   Verify the plugin is enabled in Obsidian
-   Check for `.lock` files in Claude config directories:
    -   `$CLAUDE_CONFIG_DIR/ide/` if environment variable is set
    -   `~/.config/claude/ide/` (default since Claude Code v1.0.30)
    -   `~/.claude/ide/` (legacy location)
-   The plugin writes lock files to both `~/.config/claude/ide/` and `~/.claude/ide/` for maximum compatibility
-   Restart Obsidian if the vault doesn't appear in `/ide` list

**Stale lock files**
-   If Obsidian crashes, lock files may not be cleaned up
-   Delete any `.lock` files in `~/.config/claude/ide/` and `~/.claude/ide/`, then restart Obsidian

**Auth token errors (Claude Code v2.1.69+)**
-   Lock files include an `authToken` field for secure WebSocket connections
-   If you see authentication failures, restart Obsidian to regenerate the lock file with a fresh token

**Port conflicts:**

-   Configure a different port in plugin settings
-   Update client configurations to match the new port
-   Common alternative ports: 22361, 22362, 8080, 9090

## Tool Architecture

This plugin implements a flexible tool system that allows different tools to be exposed to different MCP clients:

### Tool Categories

1. **Shared Tools** (available to both IDE and MCP clients):
   - File operations: `view`, `str_replace`, `create`, `insert`
   - Workspace operations: `get_current_file`, `get_workspace_files`
   - Obsidian API access: `obsidian_api`

2. **IDE-specific Tools** (only available via Claude Code WebSocket):
   - `getDiagnostics` - System and vault diagnostics
   - `openDiff` - Diff view operations (stub for Obsidian)
   - `close_tab` - Tab management (stub for Obsidian)
   - `closeAllDiffTabs` - Bulk tab operations (stub for Obsidian)

3. **MCP-only Tools** (only available via HTTP/SSE):
   - Currently none, but the architecture supports adding them

### Adding New Tools

To add a new tool to the plugin:

#### For Shared Tools (available to both IDE and MCP):
1. Add the tool definition to `src/tools/general-tools.ts` in the `GENERAL_TOOL_DEFINITIONS` array
2. Add the implementation in the `createImplementations()` method of `GeneralTools` class
3. The tool will automatically be available to both WebSocket and HTTP clients

#### For IDE-specific Tools:
1. Add the tool definition to `src/ide/ide-tools.ts` in the `IDE_TOOL_DEFINITIONS` array
2. Add the implementation in the `createImplementations()` method of `IdeTools` class
3. The tool will only be available to Claude Code via WebSocket

#### For MCP-only Tools:
1. Add the tool definition to `src/tools/mcp-only-tools.ts` in the `MCP_ONLY_TOOL_DEFINITIONS` array
2. Create an implementation class similar to `GeneralTools` or `IdeTools`
3. Update `src/mcp/dual-server.ts` to register the tools only to the HTTP registry

### Tool Registration Flow

The plugin uses a dual registry system:
- **WebSocket Registry**: Contains shared tools + IDE-specific tools
- **HTTP Registry**: Contains shared tools + MCP-only tools

This separation ensures that:
- Claude Code gets access to IDE-specific functionality
- Standard MCP clients only see appropriate tools
- Shared functionality is available to all clients

## Development

This project uses TypeScript to provide type checking and documentation.
The repo depends on the latest plugin API (obsidian.d.ts) in TypeScript Definition format, which contains TSDoc comments describing what it does.

### Releasing new releases

-   Update your `manifest.json` with your new version number, such as `1.0.1`, and the minimum Obsidian version required for your latest release.
-   Update your `versions.json` file with `"new-plugin-version": "minimum-obsidian-version"` so older versions of Obsidian can download an older version of your plugin that's compatible.
-   Create new GitHub release using your new version number as the "Tag version". Use the exact version number, don't include a prefix `v`. See here for an example: https://github.com/obsidianmd/obsidian-sample-plugin/releases
-   Upload the files `manifest.json`, `main.js`, `styles.css` as binary attachments. Note: The manifest.json file must be in two places, first the root path of your repository and also in the release.
-   Publish the release.
