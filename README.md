# pi-workbench

> 📖 中文文档：[README.zh-CN.md](./README.zh-CN.md)

A desktop IDE for AI coding workflows, wrapping the `pi` CLI's real terminal UI (TUI) inside multiple isolated terminals with a modern split-pane workspace.

![pi-workbench screenshot](./docs/images/screenshot.png)

---

## Features

### Pi Sessions

- Run multiple isolated `pi` CLI sessions, each in its own terminal pane.
- Sessions grouped by project directory in the sidebar, with live status indicators.
- Switch between sessions without killing the process — tasks keep running in the background, switch back instantly.
- Create, terminate, delete single or batch delete sessions.
- Unsaved sessions (pre-first-input) shown at the top of each group.

### Integrated Shell Terminals

- Spawn general-purpose shell terminals (PowerShell, CMD, Git Bash, bash, zsh) alongside pi sessions.
- VS Code-style shell integration with command tracking, output marking, and automatic cwd detection.
- Configurable default terminal profile, cursor style, font family, and scroll behavior.

### Split Pane Workspace

- Each project directory has its own independent workspace with multiple tabs and split panes.
- Split the workspace horizontally or vertically — each pane maintains its own independent tab bar.
- Drag panes' dividers to resize.
- Mix different tab types (pi sessions, shell terminals, file previews, diffs, session history) in the same pane.
- Tab history: closing the active tab returns to the previously visited tab.

### Tab Management

- Drag-and-drop reorder tabs within a pane.
- Cross-pane drag-and-drop: move a tab to another pane in the same workspace.
- Keep-alive: switching tabs preserves processes, terminal content, and scroll position — instant switch-back.
- Tab types: session, integrated terminal, file preview, diff, session content viewer.

### File Explorer

- VS Code-style file tree with virtual scrolling, optimized for large projects.
- Git status badges (M/A/D) on files and folders — see changes at a glance.
- Inline file/directory rename, create, delete.
- Cut, copy, paste files via clipboard.
- Drag files from the tree into the terminal to insert the absolute path.
- Right-click context menu with common file operations and "open with system default".
- Auto-refresh on external file changes.

### Code Editor & Preview

- **Monaco code editor** with syntax highlighting, language detection, and dirty state tracking.
- **Markdown** — three modes in one tab: rendered preview (GFM, math, Mermaid diagrams, TOC), rich text WYSIWYG (TipTap), and source editor.
- **Image preview** with zoom, pan, and zoom toolbar.
- **Diff viewer** — single-column unified diff with per-file collapsible sections, for working tree changes and commit diffs.
- External file change detection with auto-reload.

### Git Integration

- Current branch with ahead/behind indicators and change counts.
- Recent commit log — click any commit to open its diff.
- Working tree diff with real-time auto-refresh.
- File tree shows Git status badges on every file and directory.
- Git tab shows a dirty indicator (yellow dot) when there are uncommitted changes.

### Session Content Viewer

- View full pi session history as a tab in the workspace.
- Messages grouped into turns (user message + assistant response chain).
- Thinking blocks and tool calls collapsed into a "Process" section — only final replies shown.
- Launch or delete a session directly from the viewer.

### Pi Configuration Management

- **Config Editor** — edit `settings.json` (global or project scope) with a form UI or raw JSON mode.
- **Model Config** — manage providers and models with full compatibility flags, cost config, and thinking level mapping.
- **MCP Manager** — manage MCP servers across 4 config layers (user-global, pi-global, project-shared, project-pi). Supports stdio, HTTP, and Unix socket transports. Import config from cursor, claude-code, VS Code, and more.
- **Skills Manager** — list, enable, disable, delete skills. Batch operations per source group.
- **Extensions Manager** — list, enable, disable, delete installed extensions.

### Settings Panel

- **General** — theme (dark/light), close button behavior, font size, version update check.
- **Session Management** — browse, delete, or batch-delete session files.
- **Terminal** — default profile, cursor settings, font settings, scroll behavior, scrollbar width.

### Window & UI

- Frameless window with custom title bar (theme-aware).
- 8-direction edge resize zones.
- System tray with show/quit context menu.
- Splash screen on startup.
- Window state persistence (position, size, maximized).
- Single-instance lock. `pnpm dev` sets `PI_WORKBENCH_DEV=1` by default, running as a separate instance (own config, runs alongside the installed app).

### Version Update

- Check for updates via GitHub releases (no API key needed).
- On a new version, links to the release page; user downloads the installer via browser.

### Safety & Security

- Sandboxed renderer (`nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`).
- All process and PTY management lives in the main process.
- Safe cleanup: closing the app terminates all running processes.
- File system bridge with root-directory bounds-checking.

---

## Quick Start

```bash
pnpm install
pnpm dev          # Dev mode (Electron + Vite HMR)
pnpm build        # Production build
pnpm start        # Preview the built app
pnpm dist         # Build distributable (platform defaults)
pnpm dist:win     # Build Windows NSIS installer
```

## Testing

```bash
pnpm test          # Unit tests
pnpm test:watch    # Watch mode
pnpm test:e2e      # End-to-end (real Electron via Playwright)
```

## License

See repository settings.