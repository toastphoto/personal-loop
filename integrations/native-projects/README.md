# Native project connectors

One catalogue over native Codex, Multica and DeepSeek Harness projects. It preserves each provider's identity. It does not migrate projects or treat a new Multica Run as an existing model conversation.

Current delivery includes the native catalogue, explicit project selection/pause, a reliable Feishu command relay, existing-hub rule synchronization and decision replies, and an executor for loop-owned Codex threads. Live catalogue reads have verified 27 Codex projects, 9 Multica projects and 3 DSH workspaces on one installation, for 39 native entries. Every project still defaults to manual. One bounded read-only owned Codex task completed with an artifact; this is not business-workflow completion. Existing manual-chat control and Multica/DSH writes remain unaccepted.

The reviewed [read-only Host plugin](../dsh-native-bridge/README.md) is installed through the supported DSH plugin mechanism, and the Desktop app was normally quit and reopened with explicit user approval. The existing Host now supplies real workspace metadata without credential extraction or a second shared-storage Host.

Feishu deployment was also explicitly approved. Two readiness timeouts rolled back automatically: first because launchd could not access an external-volume location, then because macOS volume authorization was still awaiting the user. After the user responded to the system permission prompt, the third deployment reached ready state: the loop relay and upstream hub are healthy and the existing dispatcher is running with its reviewed command hook. No permission control was bypassed. There are no active rules, runs, timers or cards, and no test group message has been sent. Real group command/response acceptance is still pending.

## Run

Node 24, no new runtime dependencies. Copy `config.example.json` to a private directory outside this repository, fill the existing connection routes, then:

```sh
node integrations/native-projects/cli.mjs --config /private/path/config.json projects
node integrations/native-projects/cli.mjs --config /private/path/config.json tasks '<projectKey>'
node integrations/native-projects/cli.mjs --config /private/path/config.json read '<projectKey>' '<native-task-id>'
node integrations/native-projects/cli.mjs --config /private/path/config.json modes
node integrations/native-projects/cli.mjs --config /private/path/config.json mcp
```

MCP exposes only `native_projects_list`, `native_project_tasks`, `native_task_read`, and `native_loop_modes`. Its output explicitly lists unavailable providers. An unavailable provider is not an empty successful catalogue. There is no chat-body export or public network listener.

## Project selection and pause

Every discovered project defaults to `manual` (view only). Only an explicit selected goal can be `active`; `paused` persists across restart. A project whose native control capability is unavailable cannot be enabled by the CLI. Inspect the exact project key; titles alone are not identity.

Mode changes take JSON from stdin, not shell-interpolated task text:

```sh
printf '%s' '{"objective":"A bounded goal with an inspectable result","maxSteps":3,"expectedRevision":0}' | node integrations/native-projects/cli.mjs --config /private/path/config.json mode '<projectKey>' active
printf '%s' '{"expectedRevision":1}' | node integrations/native-projects/cli.mjs --config /private/path/config.json mode '<projectKey>' paused
```

Pause stops future automatic dispatch; it does not claim an already accepted native execution has stopped. Immediate cancellation is a separate action, requiring an exact execution identity and confirmed native stop. Resuming must be explicit. A stale control revision cannot overwrite a newer pause. `controls.mjs` generates rules for active projects only, using a different event type/group for each project. The Feishu handler can now synchronize rules, confirm the loaded control revision and emit a stable wakeup event through the existing hub. This path is implemented and deployed after explicit approval; a real group command/response round trip has not yet been verified.

## Provider boundaries

- **Codex**: default `control-proxy` connects only to an existing supported app-server control socket. Explicit `isolated-readonly-api` starts a short-lived official metadata API process, never a daemon; it cannot continue or cancel the desktop's active work. `includeUnassignedByRoot` optionally includes old unassigned chats at exact project roots as `membership=cwd-unassigned`; their native assignment stays null.
- **Multica**: CLI reads existing profile/workspace identity. Native projects do not advertise local directories, so roots remain empty. Issue status, execution status and business acceptance are separate. A permitted follow-up comment can trigger a new Run, coalesce or defer; it does not promise the old model session. Unknown outcomes are never blindly resent. Cancellation uses an exact Run belonging to the Issue.
- **DSH**: the existing Host Gateway supplies native Workspace membership and sessions. The client supports the official connect procedure using a configured environment variable and keeps the resulting independent operator credential only in memory. It does not copy browser cookies or extract Desktop private IPC credentials. A new SDK/headless process does not substitute for GUI project inventory. Starting an extra WorkspaceRegistry against Desktop storage may perform recovery/migration and is not an acceptable read-only fallback.

Provider versions and connection capabilities must be rechecked. Private routes, credentials, caches and operation journals belong outside the Git tree.

## Durable operations and observations

`Operations` is an internal integration API, not a publicly enabled mutation tool. It needs a current project grant and an active control record, checks step/action limits, persists an operation before dispatch, preserves unknown outcomes, and checks the latest control revision immediately before each connector write. A response saying accepted is not completion. Guards serialize checks in one caller; they do not claim an atomic cross-system transaction against concurrent native UI actions. Native mutation delivery still needs end-to-end acceptance before enabling autonomous work.

`observe <goal-id>` returns before querying a native provider when the goal is manual/paused. For active goals it refreshes metadata, checks the control revision again, and can publish a stable transition to a local autoloop hub. A pending outbox is saved before publication; a retry keeps its ID, while A → B → A uses a new transition sequence. Acknowledgement precedes checkpoint advancement. Run one observer per goal; the existing hub group/rule should enforce that deployment constraint. No text titles or full conversations enter the state-change payload.

The goal config may contain `hubConfigFile`, referencing a private existing hub config. This uses its local source identity; it never prints or sends the owner key. Without that option the observer only writes a private metadata snapshot. This module does not implement a second scheduler: events, waits, retries, cards and worker ownership remain with upstream autoloop.

## Managed worker root selection

The opt-in `native-managed` worker binds a new owned Codex session to the selected native project. It uses `managedCodex.projectRoots[projectKey]` from the trusted private config when a project has multiple roots. The configured path must be absolute and exactly match a root currently returned by the native catalogue. It never selects the first of several roots, accepts a child/outside directory, or takes a working directory from event content. An unconfigured single-root project can use that sole root; an unconfigured multi-root project stops before creating a session or starting a model.

```json
{
  "managedCodex": {
    "enabled": true,
    "stateDir": "/private/path/native-managed",
    "projectRoots": {
      "codex:local:example-project-id": "/absolute/native/project/root"
    }
  }
}
```

This fragment belongs in the existing private native configuration and does not activate a goal. Current project mode, revision, deadline and remaining steps still gate execution. The selected root is part of the owned goal identity; changing it cannot silently retarget an existing session.


## Feishu control commands

The dedicated relay only accepts new text commands from configured sender IDs in the configured group. It starts at the current queue tail; ordinary messages retain the existing dispatcher path. The existing dispatcher has the minimal reviewed hook reserving the `/loop` namespace so commands cannot also create Issues. The live patch and new service were deployed after explicit approval. Service readiness has passed; real group command handling and delivery still require acceptance.

Examples after deployment:

- `/loop 项目`
- `/loop 状态 项目名称`
- `/loop 启用 Codex:项目名称 | 明确目标 | 步数 3`
- `/loop 暂停 项目名称`
- `/loop 继续 项目名称`
- `/loop 回答 42 1`

Names must match exactly; ambiguous names require provider qualification or the stable short ID. Only verified cached names can resolve an offline registered project. Edited messages do not execute a replacement command; send a new message. The SQLite queue records commands before advancing the cursor; mode changes persist the request identity; saved responses retry independently without repeating actions. Reply retries are finite and exhausted/revoked entries cannot block newer replies.

`feishu-relay.mjs <private-config>` is the live entry. Private config includes `nativeConfigFile`, `queuePath`, `databaseFile`, `statusFile`, `profile`, `chatId`, and `allowedSenderIds`. Prepare with `--once --no-reply` only before activation; do not use it to bypass deployment approval or replay existing history. Successful configuration does not prove real message delivery.

`plugins/feishu-group-text/` implements the existing hub channel protocol with plain text, one-based choices and edits to the original notification. It does not create another event listener or send interactive cards. A stable per-hub `deliveryNamespace` is required for cross-hub idempotency. Group answers use the existing hub's decision mechanism; a pause choice removes that project's rule before answering.

## Mobile project cards

Set `projectCards: { "enabled": true }` in the private Feishu relay configuration to reply to `/loop 项目` and `/loop 状态` with Card 2.0. The directory starts with a short summary and three closed source panels; each project expands separately. Default manual mode is explained once, active/paused projects are labelled, and only duplicate titles receive a short stable suffix. Project details and exact command examples are inside the folds.

The live presentation uses native folding and has no callback buttons or dropdowns. Opening a panel never changes project mode. A pure navigation renderer exists for later callback acceptance, but it is not connected or enabled. Server-side navigation needs the application's `card.action.trigger` callback setting and a real owner event before it can be advertised as working. Do not start another same-app WebSocket or write callback update tokens into the legacy shared queue.

Structured views contain only display fields. The relay saves the complete card before delivery; retries keep the same payload and idempotency key, without repeating project actions. Existing saved text replies remain valid. Card size and element counts are bounded; any omitted entries are explicitly disclosed. All current entries must be checked against the actual rendered directory at deployment time.

The initial mobile layout was accepted by the official CardKit create-entity API using a synthetic 39-project card, without sending it. Reply dry-run and automated tests are separate from real mobile rendering acceptance. The owner confirmed the earlier plain-text group round trip; the new card still needs a real post-deployment query on the phone.

## Owned Codex execution

`ManagedCodexExecutor` creates and registers a new thread within a verified native project. It never takes ownership of an arbitrary desktop chat. Fresh threads follow the official `thread/start → turn/start` sequence; a restarted empty thread is not silently recreated. Existing owned threads preserve strict project/directory identity.

The first execution scope is **read-only**. Final report text is saved to a private worker artifact, not written into the source project. Owned execution does not prove the absence of manual work in the same source directory. It is not a general editing or production-deployment grant.

`plugins/native-managed/` runs this executor for one existing-hub run. Stable run IDs and durable intent records prevent duplicate dispatch. Unknown results block further work and create an attention request. The step budget survives pause/resume. Stop targets the exact owned turn and separately verifies its terminal state.

`managedCodex` uses `enabled`, `stateDir`, `projectRoots`, `timeoutMs` and `waitTimeoutMs`. `loopHub` uses `autoStart`, `configFile`, `rulesFile`, `workerName` and `controlCwd`. Rules remain the authority in the original hub; the helper does not add a separate scheduler. `startOwned` means a separate read-only execution is supported, not control of old manual chats. All projects still default to manual.

Token usage uses a persisted cumulative-total baseline per owned turn. Native `last` is the last model request, not the whole user turn. Missing baselines or counters are reported as missing rather than zero; raw usage is retained privately and is not a monetary bill.

## Verification

```sh
npm run test:native
npm run test:quick
npm run typecheck
npm run format:check
```

The latest recorded quick suite contains 723 tests: 721 passed and 2 skipped. This result must be rerun after relevant code changes.

Tests use fake transports, temporary files and local HTTP/WebSocket servers. They cannot prove account authorization, live mutation semantics, business acceptance, or the user's desired notification experience. The separate live evidence is limited to the three-provider catalogue, one owned read-only Codex task, DSH Host plugin loading after a normal restart, and Feishu service readiness. No real group command/response trial has been performed.
