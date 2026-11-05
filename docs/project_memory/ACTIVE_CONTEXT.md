# Active context

The fork adds `integrations/native-projects/` on branch `codex/native-project-loop`. It provides three native connector implementations and a unified read-only CLI/MCP. All projects default to manual; selected goals can have persistent active/paused modes. Original autoloop kernel and existing services are unchanged.

Verified on one local installation: Codex and Multica native project reads. Codex desktop control transport and DSH Desktop authorization remain unavailable; mutations and the full first business loop are not live-accepted. Do not call unavailable providers empty or enable every discovered project.

Read integrations/native-projects/README.md for exact capabilities. Recheck git, host versions, connections, permissions and tests. Next: finish independent review and live metadata checks, then resolve supported native control/authorization before enabling a selected project. Feishu selection/pause UI and rule synchronization remain undeployed.

Validation: 85 native-module tests passed; integrated quick run had 550 tests (548 passed, 2 skipped). Typecheck, formatting and memory checks passed. Independent review reproduced and then verified fixes for final-dispatch pause checks, state transition IDs and DSH shared fields. These are finite tests, not live native mutation acceptance. No project is enabled automatically.
