# V2 domain migration and verification record

## Baseline

Implementation uses an isolated worktree created from commit `748453e7073d434bdf8300f077d89c4e0601def3` on branch `codex/v2-domain-modules`. The dirty `integration/skill-reliability-20260906` worktree was preserved. No Minecraft server, production endpoint, credentials, or local model was accessed.

The first repository baseline `pnpm check` reached the existing bot-runtime worker suites but failed 11 tests because `packages/pathfinder-rs/pathfinder_rs.node` had not been built. The artifact is a generated, ignored N-API binary; source checkout alone does not provide it. Running `pnpm --filter @minecraft-studio/pathfinder-rs build` succeeded on Windows (Rust 1.98.0), after which bot-runtime passed (580 tests, 6 skipped) and the complete root `pnpm check` passed. A fresh checkout must run this build before the Worker integration tests.

## P0/P1/P2 implementation

| Domain | Authority and entry point | Evidence |
| --- | --- | --- |
| Base management | `@minecraft-studio/domain-management` `BaseManagement`; trusted identity verifier, invitation pattern, scope, move stage, two-gate bed/sign confirmation | `packages/domain-management/tests/domain-management.test.ts` |
| Asset policy | `@minecraft-studio/skills` `AssetPolicy`; server/world/dimension/version/revision scoped authorization, fail-closed unknown assets, OUTPUT_ONLY withdrawal, expiring grants | `packages/skills/src/asset-policy.ts`, world-assets tests |
| Resource logistics | `@minecraft-studio/skills` `ResourceLedger`; observed/stale/unknown facts, reservations, idempotent transfer orders, partial receipt reconciliation | `packages/skills/src/planning/resource-management.ts`, resource tests |
| Survival and equipment | `@minecraft-studio/domain-management` `SurvivalManagement`; food reserve, per-slot durability, deterministic diamond/netherite ranking | domain-management tests |
| Network boundary | `SharedStateServer` rejects unauthenticated non-loopback binding | shared-state tests |

The new package has no imports from `apps/*`; it contains pure rules and state ports. Runtime remains the source of backpack/equipment/world observations. Coordinator/task-system remain the task lifecycle authority. The package does not create timers, model clients, Minecraft connections, or a competing queue.

## Running verification

```powershell
pnpm --filter @minecraft-studio/domain-management typecheck
pnpm --filter @minecraft-studio/domain-management test
pnpm --filter @minecraft-studio/skills typecheck
pnpm --filter @minecraft-studio/skills test
node scripts/measure-v2-baseline.mjs
```

The isolated checks above are the current implementation evidence. The full root gate remains blocked only by the pre-existing missing native Pathfinder artifact; native Rust/FFI and Minecraft scenarios are `NOT_VERIFIED` until the addon is built and an isolated test server is available.

## Remaining stages

P3 must connect invitation and survey operations to the existing Coordinator/Runtime flow and persist bed/sign records through the authoritative storage path. P4/P5 must remove duplicate survival directors, expose the resource ledger through the existing control API, and complete external API capability checks. P6/P7 require isolated Minecraft evidence for movement, real bed respawn, machine protection, output consumption, restart recovery, and 60-minute residency. No production deployment or formal-server connection is part of this change.

