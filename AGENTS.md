# Pi-vot agent guidance

This file contains stable implementation constraints and project context for coding agents. User/developer/security-review documentation belongs in `README.md`. Current task progress belongs in `TASK.md`; do not turn either file into a chronological implementation log.

## Product intent

Pi-vot is a local, single-user browser UI over an already-installed Pi coding agent. The goal is a small, auditable graphical client, not a replacement agent runtime.

Primary environment:

- Windows 11 first
- macOS also supported
- Linux optional/supported where practical
- Chromium/Chrome browser target

Keep the UI compact and dark-mode oriented. Preserve native Pi behavior wherever possible rather than recreating it in Pi-vot.

## Architectural invariants

- Pi remains authoritative for models, provider credentials, tools, extensions, compaction, and persisted sessions.
- Use `pi --mode rpc` for live runtimes.
- Do not create a parallel session database.
- Persisted Pi sessions must remain interoperable with terminal Pi.
- Selecting/viewing a session is separate from owning a live runtime for it.
- Selecting a Pi-vot session must never wait for or mutate another session's Pi runtime. Busy/compacting/generating background runtimes must not block navigation.
- Historical sessions should remain lightweight and viewable without starting Pi.
- Wake or Send to an inactive persisted session activates that exact session; Wake never sends a prompt.
- Support at most four live Pi runtimes unless the product requirements explicitly change.
- Background runtimes continue working when another session is selected.
- State, errors, context, queues, model information, attachments, and events must remain isolated per session.
- Current project controls where new work is created and appears first in the sidebar; it must not hide other discoverable project history.

### Big Pi metadata

- Big Pi is optional. Its default folder is derived exactly as `sessionPath + ".big-pi"`; agent-scoped data is under `sessionPath + ".big-pi-agents"`. Preserve `.jsonl` in the transcript filename. Only derive these paths from transcript paths Pi-vot already knows; do not crawl for Big Pi folders.
- Disk usage counts regular-file bytes within the dedicated folder, including manifest, chunk, temporary, and unreferenced files. Do not follow symlinks. If any scan step fails, do not present a partial total as exact.
- Chunk counts must come only from the final supported versioned manifest's committed index, including dormant, superseded, missing, and damaged chunk entries. Exclude temporary and unreferenced files. Do not load chunk summaries, infer counts from filenames, or trust manifest paths to access files outside the folder.
- The supported manifest is `manifest.json` with `schemaVersion: 1`, `producer: "big-pi"`, and `blocks` as the committed index array; `session.sessionPath` must match the verified transcript path. Each entry has a unique `blockId` matching `B` plus digits, tier 1–3, a unique safe `blocks/<filename>.json` path (including safe collision suffixes), and a 64-character lowercase hexadecimal `sha256`.
- Count every valid committed index entry, including dormant, superseded, missing, and damaged chunks. Do not open chunk files to calculate counts; temporary and unreferenced files are excluded from counts but included in disk usage.
- Distinguish absent storage from missing, malformed, unsupported, and unreadable manifests. Disk usage remains independently available when reliable even if the manifest cannot be trusted.
- Keep only normalized statistics in browser-facing state; never send manifest contents or session filesystem paths for this feature.
- Reading Big Pi statistics must not wake or spawn Pi, activate an inactive session, or consume a runtime slot.

### Billion Context Pi metadata

- Detect the selected transcript's Billion Context Pi sidecar at exactly `sessionPath + ".acp.json"`; do not search session directories or activate Pi to inspect inactive sessions.
- Identify the producer by the documented `producer` prefix `billion-context-pi@`. `schemaVersion: 1` is supported; a missing schema version is accepted as the documented pre-contract v1 format. Unknown versions remain detected but their counts are unavailable.
- Count persisted `blocks[]` by tier 1–3 from each block's `blockId` (`b` plus digits) and `tier`; count all persisted blocks regardless of `active` state. Never read block summaries or modify/delete this extension-owned sidecar.
- Reuse the three-box Context indicator. When Billion Context Pi is detected, render a `B` inside its top box and show T1/T2/T3/total blocks in the tooltip. Prefer these counts when Big Pi session data is also present, and append the coexistence notice to the existing per-session warning popover after Pi notices.
- Reading Billion Context Pi metadata must not wake or spawn Pi, activate an inactive session, or consume a runtime slot.
- Show the statistics only for the selected session and refresh through existing lifecycle events; do not add a watcher or polling loop.

## Dependency and security policy

Pi-vot is expected to withstand a security audit.

### Distribution invariants

- Minimum Node.js version is `>=22.19.0`; Node 22 is the recommended/tested baseline. Newer versions are allowed but may not have the same validation coverage. Target machines do not require npm, TypeScript, or `node_modules`.
- The default port is `17361`; only `PI_VOT_PORT` overrides it. Generic `PORT` and former `PI_PANE_PORT` are unsupported.
- Node versions below `22.19.0` are blocked unless `PI_VOT_ALLOW_UNSUPPORTED_NODE` is exactly `1`; newer Node majors are allowed with an advisory warning. Former `PI_PANE_*` variables are not aliases.
- Keep release code and assets readable and auditable; assemble releases from an explicit allowlist.
- Support direct `node app/server.js` execution. PowerShell is a convenience launcher, not a runtime dependency; never require `cmd.exe`.
- Do not bypass or weaken PowerShell execution policy. Pi remains an external installed/configured prerequisite.
- Do not add startup installation, update, telemetry, or download behavior.

Prefer, in order:

1. Node standard-library APIs
2. browser/platform APIs
3. existing dependencies/components
4. a new third-party dependency only when it materially reduces complexity or risk

Do not contort the implementation into large brittle home-grown infrastructure merely to reach zero dependencies, but do not add packages for convenience.

When considering a new dependency:

- justify why existing/platform APIs are insufficient
- review its license
- review direct and transitive dependency impact
- review documented project/organization provenance
- review maintenance/security posture
- avoid projects with publicly documented project or organizational origins in China, Russia, or North Korea
- never infer provenance from contributor names, ethnicity, or other personal characteristics
- record the decision in `TASK.md`

Do not add frontend frameworks, CSS frameworks, menu/dropdown libraries, upload libraries, state-management libraries, or bundlers without a compelling requirement.

Preserve the current localhost/security posture:

- bind to `127.0.0.1`
- require a loopback peer and accepted local Host authority (`127.0.0.1:<port>` or `localhost:<port>`) for all `/api/*` requests
- for mutations, additionally require a valid local HTTP Origin when the Origin header is present
- Pi-vot remains a single-user localhost application without per-user/application authentication
- keep CSP restrictive
- do not introduce `unsafe-eval`
- avoid weakening `script-src`/`style-src` to work around implementation choices
- keep static-file serving allowlisted/constrained
- treat model content, filenames, attachment metadata, and persisted session data as untrusted input
- preserve server-side image validation and size bounds
- preserve `npm run verify:vendor`

## UI semantics to preserve

### Sessions

- Sidebar history is grouped by native session `cwd`.
- Current project group is first; other discoverable projects remain visible.
- Groups are collapsible; collapse state is browser-local.
- Green row dot means a live runtime exists. It does not mean selected/running/success.
- Selected, persisted, runtime-active, and currently-running are distinct concepts.
- Session row menus must not create horizontal sidebar scrolling or be clipped by the sidebar edge.

### Browser tab

Use these exact title strings:

- `pi - Ready`
- `pi - Running`
- `Pi - Error`

Favicon status is separate and uses shape + color:

- green check: ready/idle
- yellow dot: running
- red X: error

The selected session controls browser-tab status; unrelated background sessions do not.

### Composer

- Enter sends; Shift+Enter inserts a newline; preserve IME safety.
- Horizontal splitter below context/model controls resizes the composer.
- Conversation area must yield space and scroll internally (`min-height: 0` through the relevant flex chain).
- Composer uses explicit bounded sizing and must not push controls outside the viewport or snap back after drag.
- Send/Stop are entirely below the splitter, compact, and bottom-aligned within the composer region. They must not stretch to textarea height.
- The textarea takes the resizable vertical space and scrolls internally.

### Context/model

- Context display format is `count / total  percent` on one readable line above a text-free meter/progress bar.
- Context text should remain white/near-white in dark mode.
- Current model is clickable and opens a compact scrollable picker populated from Pi, not a hardcoded catalog.
- Model selection is per runtime/session and should not activate inactive history merely to open the picker.

### Images

- Image input supports drag/drop, clipboard paste, and native picker.
- Keep pending attachments per session.
- Attaching/browsing does not activate an inactive session; Send does.
- Preserve pending text/images on failed Send.
- Use Pi's native structured image RPC payloads and Pi model capability metadata.
- Do not generalize image support into arbitrary file/PDF ingestion without a separate product decision.

## Rendering

- Preserve Markdown source as session/message data; rendered HTML is a browser presentation detail.
- Treat assistant Markdown as untrusted.
- Raw HTML must not execute.
- Dangerous link schemes must remain inert.
- Remote Markdown images remain disabled.
- Code blocks use syntax highlighting and exact-content Copy controls.
- Thinking/tool content stays structured/collapsible rather than being blindly interpreted as Markdown/HTML.

## Compaction and delivery

- Pi controls automatic compaction.
- Manual Compact invokes Pi's native compaction.
- During compaction, locally queued messages are FIFO and temporary; they are not persisted across Pi-vot restart.
- Image payloads in queued messages must remain associated with the correct message/session.
- Do not treat a local RPC timeout as proof that compaction finished.
- `Nothing to compact (session too small)` is informational, not a scary application error.
- Refresh context from Pi after accepted user messages, assistant/tool completion, usage-bearing updates, model/session refreshes, and compaction start/completion; keep refresh results session-scoped.
- A completed compaction creates a persistent Pi-vot event in the session's `.pi-vot.jsonl` metadata sidecar. The composer notice is separate and clears on the next accepted user message or visible assistant response.
- User and assistant timestamps come from Pi message timestamps where available; compaction timestamps record completion time. Legacy messages without recoverable timestamps remain untimed.
- Pi's RPC `compaction_start`/`compaction_end` events include automatic threshold/overflow compactions, so those can be recorded without inferring events from token counts.

## Testing expectations

Normal tests must not require Pi, network access, provider credentials, or model tokens.

Before considering a change complete, run as applicable:

```sh
npm test
npm run build
npm run test:browser
npm run verify:vendor
```

Run `npm audit --audit-level=low` when registry/network access is available. Report accurately if it could not run.

`npm run test:pi-smoke` is separate because it uses the installed Pi and a real model. Never claim it ran unless it actually did.

When changing behavior, add deterministic regression coverage and Playwright coverage for user-visible browser behavior. Preserve existing tests rather than weakening them to fit a new implementation.

Useful manual checks when touching relevant areas:

- concurrency: two sessions can run simultaneously; stopping one does not affect the other; closing an idle runtime preserves history
- compaction: queue a message during compaction and verify FIFO delivery afterward
- inactive history: browse several persisted sessions without runtime-count growth; Send activates only the selected session
- composer: drag to min/max sizes, resize the window, and verify no snap-back/off-screen controls
- images: paste/drop multiple images, switch vision capability, exercise failed send and compaction queue paths

## Scope discipline

Do not implement adjacent features unless requested. In particular:

- command/slash-command support is intentionally deferred pending product decisions
- full Settings UI is optional/later
- full extension UI is later
- remote access/authentication is out of scope unless explicitly requested
- arbitrary general-file/PDF ingestion is not implied by image support

Keep `TASK.md` focused on the current objective, decisions, validation, known limitations, and next work. Avoid duplicating stable project guidance from this file or user-facing documentation from `README.md`.
