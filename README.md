# OpenCode for Obsidian

Grimoire-style side panel for **OpenCode only** — with one deliberate difference from Grimoire:

> **Conversations are never stored in extra files. Sessions are native opencode sessions, shared with all other opencode instances (CLI, TUI, web).**

- Open the CLI (`opencode`) in your vault directory, then press `/session` (or the ☰ button) in the plugin: you see the same sessions, including the ones created in the CLI — and vice versa.
- Switching a session in the plugin resumes the *same* native session (`message.list` hydration via the official `@opencode/client`), not a copy.
- Deleting/renaming/forking acts on the native session, so the CLI sees it too.

## How the sync works

The plugin connects to the **shared opencode background service** (`opencode serve --service` via `Service.ensure()` from `@opencode/client/service`) — the same server the CLI TUI uses — instead of spawning a private server with its own password. `session.list({ directory: <vault> })` therefore returns exactly the vault's sessions regardless of which client created them. A single global `event.subscribe()` loop renders live turns, including turns started from the CLI.

Only UI state (open tab → sessionId mapping, selected model/agent) is persisted in Obsidian's plugin `data.json`. There is no `.grimoire/sessions/*.meta.json` layer and no vault-side conversation files.

## Features (Grimoire look, opencode-only)

- Tab strip with numbered badges, streaming/attention states, middle-click close, right-click menu (rename/fork/reload/delete)
- Composer with model picker, effort/variant picker, agent picker, Safe/Auto-approve toggle, `/session /new /fork /rename /reload /compact` + native opencode slash commands
- History popover = native session list with search, refresh, delete
- Streaming text/reasoning/tool-call rendering, permission cards, question/form cards, usage badge, fork, interrupt
- Settings: binary path, extra env, auto-approve, max tabs, send behavior

## Install / build

```sh
npm install
npm run build   # -> main.js (copy main.js + manifest.json + styles.css into <vault>/.obsidian/plugins/opencode-obsidian/)
npm run dev     # watch mode
```

Requires desktop Obsidian (spawns/talks to local `opencode`) and an installed `opencode` CLI (2.x).

### Install via BRAT (recommended)

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs the plugin directly from this repo's GitHub releases — no manual file copying, updates included.

1. Push this repo to GitHub (public) and create a release by pushing a version tag (CI builds and attaches `main.js`, `manifest.json`, `styles.css` automatically):
   ```sh
   git remote add origin git@github.com:<user>/opencode-obsidian-plugin.git
   git push -u origin main
   git tag 0.1.0 && git push origin 0.1.0
   ```
   The tag **must** match the version in `package.json`, `manifest.json` and `versions.json` (the release workflow verifies this).
2. In Obsidian, install and enable the community plugin **BRAT** (`Obsidian42 - BRAT`).
3. Open BRAT settings → **Add Beta plugin** → enter `<user>/opencode-obsidian-plugin` → **Add Plugin**.
4. Enable **OpenCode** under Settings → Community plugins. BRAT will notify you about new releases.

For a new version later: bump the version in `package.json`, `manifest.json` and `versions.json`, merge to `main`, then push a matching tag (e.g. `git tag 0.2.0 && git push origin 0.2.0`).

## Attribution

Chat-panel layout and interaction patterns are inspired by [Grimoire](https://github.com/sandsaber/Grimoire) by Michael Makarov (MIT). No Grimoire source files are vendored here; styles and code are original implementations against the public `@opencode/client` API.
