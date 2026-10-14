# Changelog

## 0.2.0

- Pi-vot now resolves the Pi launcher independently of the project directory, supports `PI_VOT_PI_EXECUTABLE`, and protects `/api/*` routes with loopback-peer and local Host checks; mutations also require local Origin validation, and both `localhost` and `127.0.0.1` are supported while the server stays bound to loopback.
- Node.js 22.19.0 is now the minimum supported version, newer Node releases start with an advisory, and `PI_VOT_ALLOW_UNSUPPORTED_NODE=1` is only needed for older versions.
- Session switching is non-blocking during generation, compaction, and tool activity, avoids unnecessary Pi RPC refreshes, coalesces idle-session refreshes, and isolates late refreshes to their owning session.
- New Session can create a separate Pi 0.99.2 session in a project that already has a busy session, while preserving the live-runtime limit and leaving existing sessions running.
- A new session created from an awake session now inherits that session's model.
- Multiple queued follow-ups can be submitted while earlier queue acknowledgments are still pending.
- Active session rows now refresh immediately when their run state changes, and browser tests always use their own test server instead of reusing a stale process.
- Large streaming responses and transcript rendering are more responsive, and duplicate queued-message entries are prevented.
- Queued Messages shows its count, supports collapsing the group and individual messages, and starts fully collapsed; its disclosure arrows match the individual-message controls.
- Pi-vot supports Big Pi 0.1.0 chunk statistics when persisted chunks are detected, and Billion Context Pi compression shows its own icon and block statistics.
- Context usage refreshes across message, tool, model, and compaction events, and successful compactions are retained in conversation history.
- User, assistant, and compaction timestamps are displayed and persisted across session reloads using Pi metadata or Pi-vot sidecar records.
- Compaction and tool activity timers remain tied to their session when navigating between sessions.
- Restored compacting sessions keep their elapsed status visible after switching away and back.
- Big Pi tooltip fields respect hidden state, and the composer maximum now follows the space available in short viewports.
- The composer stays within its computed height after restoring a saved size in a short viewport.
- Composer sizing preserves its minimum input height at 640×480 by reducing the conversation area’s reserved minimum when space is limited.
- Responsive browser tests use 640×480 as the minimum viewport, and tooltip checks keep the tooltip open while asserting its contents.
- Browser test reset requests are handled by a single server route, preventing duplicate responses during `release:win` browser tests.
- Queue cancellation tests now cover FIFO follow-ups as well as compaction-queued messages.
- Stale “Sending to Pi…” labels are hidden when a later user or assistant message appears.
- Warning details remain discoverable on hover or focus, with a lower-right count badge sized for two digits.
- Message copy controls, safe Markdown rendering for user messages and composer previews, and in-app Markdown help were added.
- Pi-vot can be installed as a Pi package and launched with `/pi-vot`; the command reuses or starts the local server and opens the browser.
- Windows release instructions now show the extracted-folder install path, require restarting an already-running Pi, and clarify that `/pi-vot` is entered inside Pi.
- Optional per-session debug logs, compaction diagnostics, and cleanup for partial assistant messages improve troubleshooting and history accuracy.
- Fixed a send-handler exception, kept reading position stable while streaming, and made the compact composer and history-loading indicator behave consistently at smaller viewport sizes.
- Regression coverage was added for session isolation, navigation, compaction, timestamps, queue behavior, and related UI flows.

## 0.1.0

*This is the first release of the Pi-vot app.*
