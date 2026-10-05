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
- Historical sessions should remain lightweight and viewable without starting Pi.
- Wake or Send to an inactive persisted session activates that exact session; Wake never sends a prompt.
- Support at most four live Pi runtimes unless the product requirements explicitly change.
- Background runtimes continue working when another session is selected.
- State, errors, context, queues, model information, attachments, and events must remain isolated per session.
- Current project controls where new work is created and appears first in the sidebar; it must not hide other discoverable project history.

## Dependency and security policy

Pi-vot is expected to withstand a security audit.

### Distribution invariants

- Target machines use approved Node.js 22 and must not require npm, TypeScript, or `node_modules`.
- The default port is `17361`; only `PI_VOT_PORT` overrides it. Generic `PORT` and former `PI_PANE_PORT` are unsupported.
- Unsupported Node versions are blocked unless `PI_VOT_ALLOW_UNSUPPORTED_NODE` is exactly `1`; former `PI_PANE_*` variables are not aliases.
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
- enforce Host/Origin checks for mutations
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
