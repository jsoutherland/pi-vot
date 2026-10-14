# Pi-vot

Pi-vot is a local browser UI for the Pi coding agent already installed and configured on your machine. It uses Pi's native RPC and persisted sessions rather than maintaining a separate chat database or credential store.

Pi-vot supports multiple concurrent Pi sessions, browsing persisted history without starting a runtime, streaming assistant/tool activity, model switching, context/compaction controls, Markdown/code rendering, and image attachments.

Inactive persisted sessions can be inspected without starting a runtime. Choose **Wake** to activate one without sending a message; this uses one of the four runtime slots and is useful for checking current context or compacting before you resume work.

## Requirements

- Node.js `>=22.19.0` (Node 22 is the recommended/tested baseline; newer versions are allowed but may have less validation)
- `pi` installed and available in an absolute `PATH` directory, or configured with `PI_VOT_PI_EXECUTABLE`
- Pi configured with at least one provider/model
- Windows 11, macOS, or Linux
- Chromium/Chrome for the supported browser experience and browser tests

## Install and run

```sh
npm ci
npm run dev
```

The app opens in your system's default browser after the server is ready. The default local URL is:

```text
http://127.0.0.1:17361
```

To type-check and run the production mode:

```sh
npm run build
npm start
```

Override the port with `PI_VOT_PORT`:

```powershell
$env:PI_VOT_PORT = "18000"
npm start
Remove-Item Env:PI_VOT_PORT
```

```cmd
set PI_VOT_PORT=18000
npm start
```

The default port is `17361`. `PI_VOT_PORT` is the only port override; generic `PORT` and the former `PI_PANE_PORT` are ignored. Pi-vot binds to `127.0.0.1` only.

### Install as a Pi package

Pi-vot's source directory and extracted release directory are Pi packages. Install either one by passing its directory to Pi:

```sh
pi install /path/to/pi-vot
```

On Windows, quote the directory path if it contains spaces:

```powershell
pi install "C:\Tools\pi-vot-0.2.0-win-x64"
```

Install the extracted release folder by path. `pi install pi-vot` names an npm package; it does not point to the Windows release folder. After installing, restart Pi if it was already running, then type `/pi-vot` at Pi's prompt. Pi-vot starts in the current project directory and opens in the default browser. The command reuses an already-running Pi-vot server on the selected port. To remove the package later, run `pi remove <same-path>`.

Pi's package interface registers slash commands and CLI flags; it does not provide package-defined top-level commands such as `pi pi-vot`. Use `/pi-vot` inside Pi, or launch the app directly with `npm start` or the release launcher.

Set `PI_VOT_OPEN_BROWSER=0` to start the server without opening a browser automatically.

Pi-vot resolves Pi from `PATH` independently of the selected project directory. For locked-down installations, set `PI_VOT_PI_EXECUTABLE` to the absolute path of the installed Pi executable or launcher. On Windows this can be the absolute path to Pi's `.cmd` shim:

```powershell
$env:PI_VOT_PI_EXECUTABLE = "C:\Users\you\AppData\Roaming\npm\pi.cmd"
npm start
Remove-Item Env:PI_VOT_PI_EXECUTABLE
```

For opt-in troubleshooting, set `PI_VOT_DEBUG=1` or `PI_VOT_DEBUG=true` (case-insensitive). Pi-vot writes a concise JSONL event log beside each session transcript as `<session>.jsonl.pi-vot-debug.jsonl`; it keeps the full event history instead of truncating at a byte limit, and session deletion removes it. Message text, tool inputs, and tool outputs are not logged.

Relative paths are rejected. Pi-vot does not search the selected project for Pi.

## Portable Windows release

### Build machine

With Node.js `>=22.19.0` (Node 22 is the recommended/tested baseline; newer versions are allowed but may have less validation):

```sh
npm ci
npm run release:win
```

`npm run release:win` runs vendor verification, deterministic and browser tests, type-checking, compilation, release-tree validation, and an assembled-release smoke test before packaging. `npm run package:win` is the lower-level compile/assemble/validate/package command; it does not run the full test suite. The readable release directory is written under `release/`. A ZIP is created when a supported system archiver is available; generic release assembly and validation also work without one. The ZIP always contains exactly one top-level directory named `pi-vot-<version>-win-x64/` and is accompanied by `pi-vot-<version>-win-x64.zip.sha256`.

Before extracting a ZIP transferred across an air gap, verify its SHA-256 with the approved system tooling (for example, PowerShell's `Get-FileHash -Algorithm SHA256`) and compare the result, ignoring letter case, with the first field in the `.zip.sha256` sidecar. After extraction, the internal `SHA256SUMS` verifies the release files themselves; it is intentionally separate from the sidecar, which verifies the ZIP archive.

### Target machine

Requirements: Node.js `>=22.19.0` (Node 22 is the recommended/tested baseline; newer versions are allowed but may have less validation), Pi installed and configured separately, and Chrome/Chromium.

Preferred:

```powershell
& "C:\Tools\pi-vot-<version>-win-x64\pi-vot.ps1"
```

Run the launcher while the desired project directory is the caller's current directory. Using its full path lets you launch it from elsewhere without changing that directory.

If PowerShell script execution is restricted, launch directly with the approved Node executable:

```text
node "C:\Tools\pi-vot-<version>-win-x64\app\server.js"
```

Use the full path to the application; do not change to its installation directory first. No npm install or build is required on the target machine. The release contains ordinary JavaScript and local browser assets, not `node_modules`, Pi, or Node. Direct launch uses the caller's current directory as the initial project; release assets are located relative to the application. The default URL is `http://127.0.0.1:17361`; `PI_VOT_PORT` may override the port.

PowerShell:

```powershell
$env:PI_VOT_PORT = "18000"
node "C:\Tools\pi-vot-<version>-win-x64\app\server.js"
Remove-Item Env:PI_VOT_PORT
```

cmd.exe:

```cmd
set PI_VOT_PORT=18000
node "C:\Tools\pi-vot-<version>-win-x64\app\server.js"
```

#### Node versions below the minimum

The minimum Node.js version is `>=22.19.0`; Node 22 is the recommended/tested baseline. Newer Node versions are allowed, with an advisory warning when running a major newer than Node 22; they may not have received the same level of validation. `PI_VOT_ALLOW_UNSUPPORTED_NODE` is only needed to bypass the minimum-version check for older Node versions and must be exactly `1`. No `PI_PANE_*` variables are supported.

```powershell
$env:PI_VOT_ALLOW_UNSUPPORTED_NODE = "1"
node "C:\Tools\pi-vot-<version>-win-x64\app\server.js"
Remove-Item Env:PI_VOT_ALLOW_UNSUPPORTED_NODE
```

```cmd
set PI_VOT_ALLOW_UNSUPPORTED_NODE=1
node "C:\Tools\pi-vot-<version>-win-x64\app\server.js"
```

Do not weaken local PowerShell policy solely for Pi-vot. If organizational policy requires signed scripts, code signing can be applied as an organizational deployment step.

## Using Pi-vot

### Projects and sessions

- Sessions are grouped by their native Pi working directory (`cwd`). The current project is listed first.
- Persisted sessions from discoverable Pi project/session storage are shown even when their project is not currently open.
- Selecting an inactive session loads its persisted transcript without starting Pi or consuming a runtime slot.
- Sending a new message to an inactive session lazily resumes that session and creates a live runtime.
- Pi-vot allows at most **four live runtimes**. Viewing inactive history does not consume one of those slots.
- A green dot beside a session means Pi-vot currently owns a live runtime for it. Selection and runtime ownership are separate states.
- Project groups can be collapsed without stopping their sessions.
- **+ New Session** creates a Pi session in the current project directory.
- Big Pi is optional; Pi-vot works normally without it. When a session has a `session.jsonl.big-pi/` folder, Pi-vot displays regular-file disk usage without following symlinks and counts chunks from the committed index in `manifest.json` (`schemaVersion: 1`, `producer: "big-pi"`). The manifest's `session.sessionPath` must match the transcript; entries require `B`-plus-digits IDs, tiers 1–3, unique safe `blocks/<filename>.json` paths, and lowercase 64-character SHA-256 values. Counts include indexed chunks even when dormant, superseded, missing, or damaged; temporary and unreferenced files contribute only to disk usage. Invalid or unsupported manifests show counts as unavailable. Pi-vot does not read chunk summaries or use the legacy `.big-pi.json` sidecar for counts.
- Billion Context Pi is also detected from the selected session's `<session>.jsonl.acp.json` sidecar when its `producer` starts with `billion-context-pi@`. Pi-vot reads only the sidecar metadata needed to count persisted `blocks[]` entries by tier; it does not read summaries or activate Pi for inactive sessions. The Context block icon marks this source with a `B` in its top box and its hover shows T1/T2/T3/total. When both plugins' session data are detected, Billion Context Pi is the displayed source and the yellow warning popover adds a coexistence notice beneath any Pi notices.
- **Stop** aborts the current Pi operation but keeps the runtime available.
- **Close runtime** releases an idle runtime while preserving its native Pi session/history.
- Rename and delete operate on Pi's persisted session data. A live runtime must be closed before its session can be deleted.

Pi-vot and terminal Pi share the same persisted sessions; there is no Pi-vot-specific session database.

### Composer and conversation

- **Enter** sends; **Shift+Enter** inserts a newline.
- The conversation scrolls independently from the page.
- Drag the horizontal divider below the context area to resize the composer. The chosen size is stored locally in the browser and clamped to the available viewport.
- The textarea uses the resizable space while **Send** and **Stop** remain compact and bottom-aligned.
- While Pi is running, Send uses Pi's steering behavior rather than starting a second turn.

### Models and context

- Click the current model to open a scrollable list of models reported by Pi for that runtime.
- Model changes are session-specific and are disabled when Pi cannot safely switch models.
- The context meter displays Pi's current `tokens / contextWindow` and percentage when available.
- **Compact** invokes Pi's native manual compaction. Automatic compaction remains controlled by Pi.
- Messages sent during compaction are queued locally and delivered FIFO after compaction finishes. This queue is not persisted across a Pi-vot restart.

### Image attachments

Images can be attached by:

- drag-and-drop onto the composer
- pasting an image/screenshot from the clipboard
- using **Attach images**

Supported formats are PNG, JPEG, WebP, and GIF. Current limits are:

- 10 MiB per image
- 20 MiB combined per prompt
- 32 images per prompt

The selected model must advertise image input through Pi's model metadata. Failed sends preserve the typed text and pending images so they can be retried. Attaching an image to an inactive historical session does not start a runtime; Send performs lazy activation.

PDFs and arbitrary general-file attachments are not currently supported.

### Rendering

Assistant messages support Markdown including headings, lists, tables, blockquotes, links, inline code, and fenced code blocks. Fenced code is syntax-highlighted and includes a Copy control.

Thinking and tool details remain structured/collapsible UI rather than being interpreted as arbitrary HTML.

## Architecture

Pi-vot is intentionally small:

```text
Browser
   ↕ HTTP / SSE
Local Node server
   ↕ JSONL RPC
one or more `pi --mode rpc` child processes
```

Key design points:

- Pi remains authoritative for providers, credentials, models, tools, extensions, compaction, and persisted sessions.
- Historical session viewing does not require a Pi subprocess.
- Live runtimes are created lazily and isolated per session.
- Browser assets are served directly by the Node server; there is no frontend framework or bundler.
- Pi-vot stores browser-only UI preferences such as group collapse state and composer height locally, not in Pi session files.

## Security and dependency posture

Pi-vot is designed to keep its software-composition and local attack surface small.

### Dependencies

`package.json` has **zero production npm dependencies** and five direct development dependencies:

- `@playwright/test`
- `@types/node`
- `@highlightjs/cdn-assets`
- `marked`
- `typescript`

These packages support development/tests and source the vendored browser assets; they are not required on target machines. Two third-party browser components are shipped as vendored runtime assets:

- Marked 16.4.1 (MIT)
- Highlight.js 11.12.0 (BSD-3-Clause)

Their exact source package paths, upstream repositories, license files, and SHA-256 digests are recorded in [`web/vendor/THIRD_PARTY.json`](web/vendor/THIRD_PARTY.json). Verify the checked-in assets with:

```sh
npm run verify:vendor
```

Original third-party license texts are included under `web/vendor/`.

### Browser/server controls

Pi-vot:

- binds only to `127.0.0.1`
- requires every `/api/*` request to come from a loopback peer and use `127.0.0.1:<port>` or `localhost:<port>` for its Host authority
- additionally validates the Origin on mutation requests when present
- uses a restrictive Content Security Policy
- sends `X-Content-Type-Options: nosniff`
- sends `Referrer-Policy: no-referrer`
- uses a restrictive Permissions Policy
- serves only explicitly allowed static assets
- treats model Markdown as untrusted input
- escapes raw model HTML
- blocks dangerous Markdown URL schemes
- does not load Markdown-provided remote images
- validates image attachment MIME/signature/size server-side
- does not store provider credentials

Pi-vot is a single-user localhost application without per-user or application authentication. These controls are defense in depth; they do not replace normal dependency review, code review, or vulnerability scanning.

## Development and validation

Useful commands:

```sh
npm run build
npm test
npm run test:browser
npm run verify:vendor
npm run test:pi-smoke
```

- `npm run build` runs TypeScript type checking.
- `npm test` runs deterministic tests without Pi, provider credentials, model calls, or network access.
- `npm run test:browser` runs Playwright tests against a deterministic fake Pi service. Install Chromium once with `npx playwright install chromium` if needed.
- `npm run verify:vendor` verifies vendored runtime assets against their recorded SHA-256 digests.
- `npm run test:pi-smoke` uses the installed Pi and configured model and therefore performs a real model call.

For dependency/security review, also run when registry/network access is available:

```sh
npm audit --audit-level=low
```

## Current limitations

- Single-user, localhost-only application; there is no authentication or remote-access mode.
- At most four live Pi runtimes are supported.
- Pi's branch/tree history is preserved in native sessions, but Pi-vot presents the current conversation linearly.
- Full Pi extension UI dialogs are not implemented. Unsupported blocking extension UI requests are surfaced and cancelled rather than silently hanging.
- General-file/PDF attachments are not implemented; image attachments are supported.
- Features depend on the RPC capabilities exposed by the installed Pi version. Missing native capabilities are reported or shown as unavailable rather than replaced with a parallel Pi-vot implementation.

## Contributing

I’m not accepting general pull requests at this time, unless we already know each other and have discussed the change.

Issues are very welcome, though. If you find a bug, have a feature request, or want to suggest an improvement, please open an issue.

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
