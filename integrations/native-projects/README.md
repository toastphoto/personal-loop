# Native project connectors

One catalogue over native Codex, Multica and DeepSeek Harness projects. It preserves each provider's identity. It does not migrate projects or treat a new Multica Run as an existing model conversation.

Current delivery includes the native catalogue, explicit project selection/pause, a reliable Feishu command relay, existing-hub rule synchronization and decision replies, and an executor for loop-owned Codex threads. Live catalogue reads have verified 27 Codex projects, 9 Multica projects and 4 DSH workspaces on one installation, for 40 native entries. Every project still defaults to manual. One bounded read-only owned Codex task completed with an artifact; this is not business-workflow completion. Existing manual-chat control and Multica/DSH writes remain unaccepted.

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

MCP exposes only `native_projects_list`, `native_project_tasks`, `native_task_read`, and `native_loop_modes`. Its output explicitly lists unavailable providers. An unavailable provider is not an empty successful catalogue. These MCP tools do not export conversation bodies, and there is no public network listener. The separately opt-in card activity reader is described below.

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

The dedicated relay only accepts new text commands from configured sender IDs in the configured group. It starts at the current queue tail; ordinary messages retain the existing dispatcher path. The existing dispatcher has the minimal reviewed hook reserving the `/loop` namespace so commands cannot also create Issues. The live patch and new service were deployed after explicit approval. Service readiness, real owner queries/replies and navigation callbacks have passed; task execution and business acceptance remain separate.

Examples after deployment:

- `/loop 项目`
- `/loop 状态 项目名称`
- `/loop 启用 Codex:项目名称 | 明确目标 | 步数 3`
- `/loop 暂停 项目名称`
- `/loop 继续 项目名称`
- `/loop 回答 42 1`

Names must match exactly; ambiguous names require provider qualification or the stable short ID. Only verified cached names can resolve an offline registered project. Edited messages do not execute a replacement command; send a new message. The SQLite queue records commands before advancing the cursor; mode changes persist the request identity; saved responses retry independently without repeating actions. Reply retries are finite and exhausted/revoked entries cannot block newer replies.

`feishu-relay.mjs <private-config>` is the live entry. Private config includes `nativeConfigFile`, `queuePath`, `databaseFile`, `statusFile`, `profile`, `chatId`, and `allowedSenderIds`. Prepare with `--once --no-reply` only before activation; do not use it to bypass deployment approval or replay existing history. Successful configuration does not prove real message delivery.

The group channel uses the existing relay and a stable per-hub `deliveryNamespace`. Text notifications and one-based `/loop 回答` commands remain supported. To send new decision questions as Card 2.0 buttons, enable `interactiveAsks` on the matching private channel and set `interactiveAsksFromId` to the first new card number at rollout. Older messages retain their original format. The existing callback subscriber routes owner clicks through the channel's answer API with the delivered message ID. The hub updates that message and wakes the selected project when the answer is recorded. A pause choice first removes the project's rule.

## Mobile project cards and owner interaction

`projectCards.enabled` enables Card 2.0 directory/status replies. The mobile directory uses three native source folds, showing the full current project list inside each source. Clicking a project opens its operation page. There is no pagination or project-picker dropdown in the current entry. Duplicate titles receive short stable suffixes; any platform-size overflow is explicitly disclosed.

With `cardCallbacks.enabled`, the relay starts one official `card.action.trigger` consumer on the existing profile's event bus. This shares the WebSocket; it never starts another same-app connection or stops unrelated consumers. The private callback directory must be 0700 and its queue 0600. Update tokens and original card bodies are stripped before persistence. A bound owner-only probe must be received before interactive controls are unlocked; subscriber readiness alone is not proof that the developer-console callback setting is enabled.

Project details offer goal drafts, start confirmation, pause and resume according to current capability and mode. Saving a draft does not activate a project or replace its running goal. Start/resume confirmation shows the complete objective and step limit; resume keeps the original goal and used budget. Unconnected execution remains unavailable. Pause prevents future steps and is distinct from cancelling the current native task.

`CardSessions` binds the owner, group, actual bot message, issued controls, card revision and current project-control revision. Each callback is deduplicated by event ID, not message ID. A repeated or stale click cannot replay a mutation or overwrite a newer pause. A crash after an unconfirmed activation is reconciled conservatively to pause only if the matching control revision remains current. Existing decisions made later are preserved.

Browsing, editing a draft and returning to the directory use the saved native catalogue plus current local controls/drafts. They do not query native providers or relabel the snapshot as fresh. Refresh and start/resume confirmation perform live checks; final activation still passes the existing mutation guards. A persisted callback wakes the main relay immediately. Initial directory/query results are reused instead of reading all providers twice.

Owner-mentioned natural project requests are reserved by the same `feishu-route.mjs` classifier used by the legacy dispatcher. The private routing file contains verified bot-mention IDs and project-name hints. Other ordinary messages retain their old path. The deterministic `feishu-intent.mjs` supports common single-project directory/status questions and operation proposals; it is not a general language-model chat service. Short or ambiguous names, negation, reported/quoted text, and multi-project actions are clarified rather than executed. “This project” uses a recently delivered or selected card, scoped to the owner and group. Natural mutations display a card for explicit action.

The complete card payload is saved before delivery or patching. Unknown PATCH results can still arrive out of order at the remote service; stale card revisions are rejected and a subsequent click refreshes the current view. Do not claim a cross-service atomic update guarantee.

The owner has exercised real navigation callbacks, and the corrected folding directory has been patched onto the original card. Synthetic goal/start/resume/probe cards also passed official CardKit create-entity validation without being sent. Real goal submission and actual native task execution from a control button remain separate acceptance steps; tests do not establish business completion.

## Selected task and Agent reply

`projectActivity.enabled` on the private relay enables a selected-project activity panel. Each provider separately requires `allowConversationPreview:true`; DSH Desktop additionally requires the 0.1.1 Host plugin with `allowReplyPreview:true`. Existing metadata/MCP methods remain body-free.

`ProjectActivity` queries only the selected provider, validates project and task membership, lists up to three selectable records and reads one bounded assistant reply. Native running records are preferred when trusted; otherwise selection is based on known update times or is explicitly marked as uncertain. A recent record is not automatically the currently running task. Codex isolated reads remain stored/unknown runtime state; directory-associated old chats keep that label.

Only public Agent text is shown, normally at most 1600 Unicode characters, with source/time/truncation labels. Reasoning, tool payloads and arbitrary native fields are excluded. Obvious credential shapes are masked; this finite filter is not a general data-classification guarantee. Replies are data for the owner, never commands or permission to take over the original session. The panel can switch recent records and refresh replies.

Reads coalesce, cache for 30 seconds and have an 8-second UI deadline. Failed reads show a missing/stale state without claiming the Agent has done no work. A selected reply read is distinct from browsing the directory, which remains cached.

## Owned Codex execution

`ManagedCodexExecutor` creates and registers a new thread within a verified native project. It never takes ownership of an arbitrary desktop chat. Fresh threads follow the official `thread/start → turn/start` sequence; a restarted empty thread is not silently recreated. Existing owned threads preserve strict project/directory identity.

The first execution scope is **read-only**. Final report text is saved to a private worker artifact, not written into the source project. Owned execution does not prove the absence of manual work in the same source directory. It is not a general editing or production-deployment grant.

`plugins/native-managed/` runs this executor for one existing-hub run. Stable run/attempt IDs and durable intent records prevent duplicate dispatch. A new upstream attempt runs only after its same-goal predecessor is verified to have completed with a valid failed receipt. Unknown results block further work and create an attention request. The step budget survives pause/resume. Stop targets the exact owned turn and separately verifies its terminal state.

`managedCodex` uses `enabled`, `stateDir`, `projectRoots`, `timeoutMs` and `waitTimeoutMs`. `loopHub` uses `autoStart`, `configFile`, `rulesFile`, `workerName` and `controlCwd`. Rules remain the authority in the original hub; the helper does not add a separate scheduler. `startOwned` means a separate read-only execution is supported, not control of old manual chats. All projects still default to manual.

`maxSteps` limits actual automatic execution attempts, including confirmed-failure retries; it is not an internal tool-call count or a promise to run exactly that many times. Valid `later/ask/notice` receipts reach the upstream kernel. A malformed receipt is preserved and safely surfaced as an attention request without repeating business or its usage; affected goals remain isolated until explicitly investigated.

Token usage uses a persisted cumulative-total baseline per owned turn. Native `last` is the last model request, not the whole user turn. Missing baselines or counters are reported as missing rather than zero; raw usage is retained privately and is not a monetary bill.

## Verification

```sh
npm run test:native
npm run test:quick
npm run typecheck
npm run format:check
```

The latest recorded quick suite contains 723 tests: 721 passed and 2 skipped. This result must be rerun after relevant code changes.

Tests use fake transports, temporary files and local HTTP/WebSocket servers. They cannot prove account authorization, live mutation semantics, business acceptance, or the user's desired notification experience. The separate live evidence is limited to the three-provider catalogue, one owned read-only Codex task, DSH Host plugin loading after a normal restart, and Feishu service readiness. Real owner group queries, replies and navigation callbacks have been exercised. Bounded reply samples from all three native sources were read without starting models.

The execution policy follows the upstream event/later/answer lifecycle and keeps ordinary completion/no-change quiet. The worker supplies `AGENT_AUTOLOOP_ATTEMPT`; missing values default to legacy attempt 1. Attempt 1 retains old ledger/request keys, while attempts 2–10 get distinct keys and consume budget. Upstream backoff and scheduling remain authoritative. See `docs/project_memory/EXECUTION_ALIGNMENT_20261106.md` for isolated evidence and the open performance-budget findings.

The project detail card shows a short handoff and available actions. Optional panels contain the bounded source excerpt, named conversation history and goal details. New native goals ask the worker to begin successful results with a concise human handoff and to reserve group questions for a specific owner decision. A private, verified historical summary applies only to its selected project, conversation and matching reply. Other replies use their own visible text. Opening a card reads display data without launching a model.

## Delegating a goal from the owner group

To opt in one managed read-only Codex project, enable its exact project key in private `managedCodex.coordinatorProjectKeys`. Add its `projectKey`, exact display `name` and an ISO `enabledAt` in the private routing file's `directGoalProjects` array. The relay requires both settings, the verified owner, the matching bot mention and an active interactive decision channel. A clear goal naming that project can start it without a second confirmation. The target provider must be complete and confirm the configured identity. Other projects retain their normal controls. A paused project or a different active goal is never silently replaced.

Each newly assigned goal has a control generation. A read-only coordinator turn receives access to a bounded progress snapshot for that project and returns one next step or one question with a recommendation and a reason. A scoped hub event or the owner's answer wakes a separate read-only worker, which receives the agreed instructions and returns a short deliverable or a justified review. Both roles consume the existing attempt budget. The coordinator pilot uses at most three turns per direct goal. Use native role/session evidence, the original IM message, the delivered question, and the actual answer event to validate a live walkthrough.

For a group channel, optional `interactiveResultsFromId` sets the first new notice number to deliver as a mobile result card. Short notices stay compact and long deliverables fold under the summary. Preserve the rollout number on restart so older messages can still be updated in their original format.
