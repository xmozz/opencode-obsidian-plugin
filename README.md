# OpenCode Sync for Obsidian

Chat with [OpenCode](https://opencode.ai) directly inside Obsidian — with sessions that are **shared live with your terminal, not copied into extra files**.

Open `opencode` in your vault folder, then open a session in the plugin (or vice versa): both sides always see and continue the *same* native sessions.

## Installation (1 minute)

No GitHub setup needed — the plugin is already published here. You only need the link.

1. Install and enable the community plugin **BRAT** (`Obsidian42 - BRAT`).
2. Open BRAT settings → **Add Beta plugin** → enter:
   ```
   xmozz/opencode-obsidian-plugin
   ```
   → **Add Plugin**.
3. Enable **OpenCode Sync** under Settings → Community plugins, then open it via the ribbon icon (🤖) or command palette.
4. BRAT notifies you automatically whenever a new version is released.

Requirements: **desktop** Obsidian plus an installed `opencode` CLI (2.x) with at least one configured provider/model.

## How it works

The plugin talks to the **same shared opencode background service as the CLI**, so every client operates on the same session database:

- `/session` (or the ☰ button) lists the vault's sessions — including ones created in the terminal — and switches to them.
- Sending, renaming, forking or deleting acts on the native session, so the CLI sees it too.
- Turns started in the CLI stream live into open plugin tabs.
- Nothing is stored in vault files: only UI state (open tabs, selected model/agent) lives in Obsidian's plugin `data.json`.

## Features

- **Tabs**: numbered, with working indicator (spinner + pulsing border) while the agent writes; hover-× and middle-click to close; right-click menu (rename/fork/reload/delete); shrink-to-fit instead of scrolling.
- **Composer box**: file chips on top (focused note or PDF auto-attached, `+ Add` vault picker for notes and PDFs, 📎 system explorer for any file, drag & drop, paste images via Ctrl+V), full Obsidian Markdown rendering (callouts, tables, tasks, highlights, LaTeX), slash-command menu (`/`), model/agent/effort pickers, Safe/Auto-approve toggle, send/stop.
- **Tool transparency**: shell/edit/read calls stream live; file edits render as GitHub-style diffs with `+N −M` stats (new files all-green).
- **Turn metadata**: timestamp plus working duration (`· 1m 24s`) under every answer; per-message copy button; tokens · cost · context-window % at the top of the composer.
- **Permissions & questions**: approval cards and structured question cards inline; Safe mode asks, Auto-approve accepts.
- **Settings**: binary path, extra env, auto-approve, max tabs, font size, LaTeX/Obsidian-syntax session hint, auto-attach, send behavior, reconnect + connection diagnostics export.

## Manual install / build

```sh
npm install
npm run build   # -> main.js
```

Copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/opencode-sync/` and enable the plugin. `npm run dev` starts watch mode.

## Notes

- Design is inspired by [Grimoire](https://github.com/sandsaber/Grimoire) — all code here is an original implementation against the public `@opencode/client` API.
- License: MIT, see [LICENSE](LICENSE).
