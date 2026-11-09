# Execution alignment — 2026-11-06

The owner approved adopting the upstream event/later/answer workflow with on-demand notifications and no fixed hourly digest. Preserve explicit project selection, persistent pause, existing access scope and bounded execution. No real project was enabled for this change.

## Implemented

- Generated rules remain event-driven and `tell:needed`, with no cron added. The prompt now follows the upstream context/receipt contract: do current permitted work, schedule a justified recheck, ask and exit for owner-only decisions, and keep ordinary completion/no-change quiet. Unused budget does not create more work.
- The original worker now exports the trusted `AGENT_AUTOLOOP_ATTEMPT` from the hub Job after removing inherited control environment variables. This is an additive adapter input; the scheduling core and its backoff remain unchanged.
- Native idempotency is per `(run, attempt)`. Attempt 1 keeps legacy keys. Later attempts need the immediately preceding attempt for the same goal to have a verified completed native turn and a valid `failed` receipt. Unknown/intent/missing/invalid results, skipped attempts and changed goals cannot authorize retries.
- Continuation uses the same owned goal/session and explicitly preserves completed work. Each real native attempt consumes one round of the goal budget; replay/receipt correction does not dispatch again. Retry request IDs, cancellation IDs, artifacts and usage are separated.
- Existing-record replay also checks goal identity and current control revision before/after asynchronous catalogue work. It cannot carry an old goal's result/session/usage into a new one. Already-executed work keeps its real result/usage even if the owner pauses while it finishes.

## Evidence and limits

`execution-flow.test.mjs` exercises real temporary hub state, SQLite facts, generated rules, managed wrapper, adapter and receipt parsing. It verifies manual/enable, quiet completion, scheduled continuation, ask/answer, pause, and confirmed-failure backoff. Native execution and metadata are substitutes, and time is advanced explicitly. It is not real business or native-model acceptance. `worker.test.ts` additionally checks attempt 1/2 in real local subprocess environments and rejects inherited spoofed values.

- Full test run: 924 tests, 922 passed, 2 skipped, including 200,000 fault steps and 40,320 bounded schedules. This run preceded the final two replay-window regression cases.
- Final quick run after those fixes: 921 tests, 919 passed, 2 skipped. Type and formatting checks passed.
- Deep checks: 1,000 actual test-process SIGKILLs and all 31 executable mutations passed.
- The nightly command did not pass its performance stage. Isolated benchmark still measured cold start 166.1015 ms (budget 150), idle RSS 111.788 MB (budget 60.4), durable events 1107.34/s (minimum 2000). Dispatch p99 2.90 ms and busy heartbeat p99 0.7 ms passed their 10 ms limits. No budget was relaxed.
- A limited cold-start comparison against unchanged HEAD measured baseline 179.93/161.39/147.47 ms versus current 182.16/178.57/162.14 ms. The benchmark's core path files are unchanged, but this is only diagnostic evidence, not a passing benchmark or proof about all platform effects.

Keep performance budgets as an open issue. Runtime/business acceptance and full upstream-version upgrade remain separate work. Existing weekly memory maintenance is unrelated to reporting and remains unchanged.
