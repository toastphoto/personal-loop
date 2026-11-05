# Native project connectors

One catalogue over native Codex, Multica and DeepSeek Harness projects. It preserves each provider's identity. It does not migrate projects or treat a new Multica Run as an existing model conversation.

Current delivery: a read-only CLI/MCP interface, provider control implementations behind explicit write gates, project selection/pause state, a durable operation journal and a state-change source for the existing autoloop hub. Live read-only Codex and Multica queries have been verified on one installation. DeepSeek Desktop requires a supported authorization path that is not available on that installation. Native mutations and a full autonomous business loop have not been live-accepted. No existing Feishu relay or Agent configuration is changed by these files.

## Run

Node 24, no new runtime dependencies. Copy `config.example.json` to a private directory outside this repository, fill the existing connection routes, then:

```sh
node integrations/native-projects/cli.mjs --config /private/path/config.json projects
node integrations/native-projects/cli.mjs --config /private/path/config.json tasks '<projectKey>'
node integrations/native-projects/cli.mjs --config /private/path/config.json read '<projectKey>' '<native-task-id>'
node integrations/native-projects/cli.mjs --config /private/path/config.json modes
node integrations/native-projects/cli.mjs --config /private/path/config.json mcp
```

MCP currently exposes only `native_projects_list`, `native_project_tasks`, `native_task_read`, and `native_loop_modes`. Its output explicitly lists unavailable providers. An unavailable provider is not an empty successful catalogue. There is no chat-body export or public network listener.

## Project selection and pause

Every discovered project defaults to `manual` (view only). Only an explicit selected goal can be `active`; `paused` persists across restart. A project whose native control capability is unavailable cannot be enabled by the CLI. Inspect the exact project key; titles alone are not identity.

Mode changes take JSON from stdin, not shell-interpolated task text:

```sh
printf '%s' '{"objective":"A bounded goal with an inspectable result","maxSteps":3,"expectedRevision":0}' | node integrations/native-projects/cli.mjs --config /private/path/config.json mode '<projectKey>' active
printf '%s' '{"expectedRevision":1}' | node integrations/native-projects/cli.mjs --config /private/path/config.json mode '<projectKey>' paused
```

Pause stops future automatic dispatch; it does not claim an already accepted native execution has stopped. Immediate cancellation is a separate action, requiring an exact execution identity and confirmed native stop. Resuming must be explicit. A stale control revision cannot overwrite a newer pause. `controls.mjs` generates rules for active projects only, using a different event type/group for each project. Installing/updating those rules and the Feishu selection UI is not yet wired into a live deployment.

## Provider boundaries

- **Codex**: default `control-proxy` connects only to an existing supported app-server control socket. Explicit `isolated-readonly-api` starts a short-lived official metadata API process, never a daemon; it cannot continue or cancel the desktop's active work. `includeUnassignedByRoot` optionally includes old unassigned chats at exact project roots as `membership=cwd-unassigned`; their native assignment stays null.
- **Multica**: CLI reads existing profile/workspace identity. Native projects do not advertise local directories, so roots remain empty. Issue status, execution status and business acceptance are separate. A permitted follow-up comment can trigger a new Run, coalesce or defer; it does not promise the old model session. Unknown outcomes are never blindly resent. Cancellation uses an exact Run belonging to the Issue.
- **DSH**: the existing Host Gateway supplies native Workspace membership and sessions. The client supports the official connect procedure using a configured environment variable and keeps the resulting independent operator credential only in memory. It does not copy browser cookies or extract Desktop private IPC credentials. A new SDK/headless process does not substitute for GUI project inventory. Starting an extra WorkspaceRegistry against Desktop storage may perform recovery/migration and is not an acceptable read-only fallback.

Provider versions and connection capabilities must be rechecked. Private routes, credentials, caches and operation journals belong outside the Git tree.

## Durable operations and observations

`Operations` is an internal integration API, not a publicly enabled mutation tool. It needs a current project grant and an active control record, checks step/action limits, persists an operation before dispatch, preserves unknown outcomes, and checks the latest control revision immediately before each connector write. A response saying accepted is not completion. Guards serialize checks in one caller; they do not claim an atomic cross-system transaction against concurrent native UI actions. Native mutation delivery still needs end-to-end acceptance before enabling autonomous work.

`observe <goal-id>` returns before querying a native provider when the goal is manual/paused. For active goals it refreshes metadata, checks the control revision again, and can publish a stable transition to a local autoloop hub. A pending outbox is saved before publication; a retry keeps its ID, while A → B → A uses a new transition sequence. Acknowledgement precedes checkpoint advancement. Run one observer per goal; the existing hub group/rule should enforce that deployment constraint. No text titles or full conversations enter the state-change payload.

The goal config may contain `hubConfigFile`, referencing a private existing hub config. This uses its local source identity; it never prints or sends the owner key. Without that option the observer only writes a private metadata snapshot. This module does not implement a second scheduler: events, waits, retries, cards and worker ownership remain with upstream autoloop.

## Verification

```sh
npm run test:native
npm run test:quick
npm run typecheck
npm run format:check
```

Tests use fake transports, temporary files and local HTTP/WebSocket servers. They cannot prove account authorization, live mutation semantics, business acceptance, or the user's desired notification experience.
