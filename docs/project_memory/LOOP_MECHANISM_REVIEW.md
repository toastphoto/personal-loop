# Loop mechanism review — 2026-11-05

This is a source review, not a speed benchmark or business acceptance. Our core base is upstream v1.1.1 / `22312e16419fc9f542a58044cfbb76f4aec80623`; kernel/host/protocol/cli remain unchanged; the 2026-11-06 alignment adds a trusted attempt environment field to the worker, without replacing scheduling. The reviewed release is [v1.2.0](https://github.com/KKKKhazix/agent-autoloop/releases/tag/v1.2.0). Reviewed main `f25ce4a053282a84a13b1c1d4052f0d762692fcb` was 9 commits beyond that release. Recheck versions before upgrading.

## What wakes work

An external event, configured cron, due `later` or owner answer enters the queue. The worker launches an Agent for one run. The Agent chooses the next business step using its trusted rule/Skill and current evidence. It can finish this run, schedule a dated recheck with `later`, or return `ask` and exit while waiting for the owner. The scheduler stays resident; the model does not continuously think while idle. A run ending is not necessarily the entire goal being accepted.

Sources: [worker contract](https://github.com/KKKKhazix/agent-autoloop/blob/22312e16419fc9f542a58044cfbb76f4aec80623/worker/contract.ts), [protocol](https://github.com/KKKKhazix/agent-autoloop/blob/22312e16419fc9f542a58044cfbb76f4aec80623/docs/protocol.md).

## What we add, and what remains incomplete

| Area | Current integration |
|---|---|
| Native ownership | Codex projects, Multica Issues and DSH Workspaces retain their native identities |
| Mobile control | Owner-scoped folding cards, separate goal drafts, explicit activation/resume and persistent pause |
| Execution | A goal owns a dedicated read-only Codex conversation; later runs for that same goal reuse it. Existing manual chats and Multica/DSH writes are not generally enabled |
| Continuation | Valid model `later/ask/notice/events` reaches the unchanged upstream parser/kernel. Our selected-project rule begins with an event |
| Observation gap | `observe` is a CLI entry, not a deployed continuous observer. Without a new event or `later`, remaining budget does not generate another run |
| Budget | `maxSteps` caps actual native execution attempts, including confirmed-failure retries, not internal tool calls, money, or a promise to run exactly that many times |
| Reply failure | A malformed receipt is now preserved and converted to a valid attention request without redoing business or recounting usage. This is conservative recovery, not automatic AI receipt repair |
| Session visibility | The selected project's bounded public Agent reply is read on demand and cached. It is evidence for the owner, not authorization to resume that original manual conversation |

## Reporting

The default `tell` is `needed`; our rules use the same setting. Ordinary `done` is retained as a result but is not automatically sent to Feishu. `ask` and explicit `notice` go through the channel. `tell:always` sends after successful runs; it is not a clock-based reporting interval. Fixed daily/hourly summaries require a separately configured reporting schedule. Meaningful changes, completion, blocking and decisions are sensible notification triggers; unchanged state should remain quiet.

Reviewed main adds `notice.fyi` for informational reports. Our old base does not accept that field, so do not emit it until compatible upstream changes are integrated. Reviewed main also adds a DSH headless adapter requiring DSH 0.2.2+; it is not a replacement for reading Desktop Workspaces. [Reviewed DSH adapter](https://github.com/KKKKhazix/agent-autoloop/blob/f25ce4a053282a84a13b1c1d4052f0d762692fcb/plugins/dsh/agent.ts).

## Latency evidence and limits

On one installation, two authenticated Feishu message reads took about 1.69 s each, while local card rendering averaged about 0.8 ms. This is not an end-to-end click or Agent-execution benchmark. The card path includes event delivery and a remote update; the CLI callback path also fetches original card content. Native execution speed depends on the model, context and task. There is no evidence here that the shared scheduler is slower.

## Next validation

Keep project selection explicit. Show native session/Issue identity, reply source and timestamps without claiming unknown execution states are idle or complete. Validate a selected goal through multiple real scheduled/answer-driven runs and its reporting policy before describing the installation as full autonomous project advancement. Review compatible upstream fixes separately; do not merge a moving main branch into the live runtime without tests.

## Hourly-report recheck

Rechecked 2026-11-05 against upstream `a3b77bf26c0b98bb9eb1edd10ede2e3c13bfdd5d`: [default tell remains needed](https://github.com/KKKKhazix/agent-autoloop/blob/a3b77bf26c0b98bb9eb1edd10ede2e3c13bfdd5d/protocol/rules.ts#L110). The optional [Feishu brief recipe](https://github.com/KKKKhazix/agent-autoloop/blob/a3b77bf26c0b98bb9eb1edd10ede2e3c13bfdd5d/examples/recipes/feishu-brief/rules.json) runs Sunday at 18:00 Asia/Shanghai only when selected. References to one hour in retry/delivery rules are not a briefing interval.

The live native hub currently has no cron/elsewhere schedules or goals, and relevant loop/relay launch agents have no hourly interval. The existing weekly project-memory reminder is separate. No runtime schedule needed removal; preserve the owner's preference for on-demand notifications without a forced hourly digest. Recheck volatile schedules in later work.

Execution defaults and the retry-identity fix were adopted on 2026-11-06; see [alignment and validation](EXECUTION_ALIGNMENT_20261106.md). This does not install a fixed periodic observer or an hourly report.
