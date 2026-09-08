# V2 domain migration and verification record

## Baseline

Implementation uses an isolated worktree created from commit `748453e7073d434bdf8300f077d89c4e0601def3` on branch `codex/v2-domain-modules`. The dirty `integration/skill-reliability-20260906` worktree was preserved. The initial domain changes did not connect to Minecraft. Subsequent identity work and the user-authorized canary have separate evidence.

The first repository baseline `pnpm check` reached the existing bot-runtime worker suites but failed 11 tests because `packages/pathfinder-rs/pathfinder_rs.node` had not been built. The artifact is a generated, ignored N-API binary; source checkout alone does not provide it. Running `pnpm --filter @minecraft-studio/pathfinder-rs build` succeeded on Windows (Rust 1.98.0), after which bot-runtime passed (580 tests, 6 skipped) and the complete root `pnpm check` passed. A fresh checkout must run this build before the Worker integration tests.

## Implemented components and their current scope

| Domain | Component and entry point | Evidence |
| --- | --- | --- |
| Base management | `@minecraft-studio/domain-management` `BaseManagement`; trusted identity verifier, invitation pattern, scope, move stage, two-gate bed/sign confirmation | `packages/domain-management/tests/domain-management.test.ts` |
| Asset policy | `@minecraft-studio/skills` `AssetPolicy`; server/world/dimension/version/revision scoped authorization, fail-closed unknown assets, OUTPUT_ONLY withdrawal, expiring grants | `packages/skills/src/asset-policy.ts`, world-assets tests |
| Resource logistics | `@minecraft-studio/skills` `ResourceLedger`; observed/stale/unknown facts, reservations, idempotent transfer orders, partial receipt reconciliation | `packages/skills/src/planning/resource-management.ts`, resource tests |
| Survival and equipment | `@minecraft-studio/domain-management` `SurvivalManagement`; food reserve, per-slot durability, deterministic diamond/netherite ranking | domain-management tests |
| Network boundary | `SharedStateServer` rejects unauthenticated non-loopback binding | shared-state tests |

The new package has no imports from `apps/*`; it contains pure rules and state ports. Runtime remains the source of backpack/equipment/world observations. Coordinator/task-system remain the task lifecycle authority. The package does not create timers, model clients, Minecraft connections, or a competing queue.

The small in-memory `domain-management` classes are rule prototypes, not a completed migration or an integrated gameplay loop. Their bed/sign flags do not prove an actual bed binding or sign readback. Duplicate domain authorities still need consolidation with the existing skills and Coordinator implementation. The preserved local integration worktree contains relevant work that must be reviewed before that consolidation; the clean baseline does not supersede it.

## Running verification

```powershell
pnpm --filter @minecraft-studio/domain-management typecheck
pnpm --filter @minecraft-studio/domain-management test
pnpm --filter @minecraft-studio/skills typecheck
pnpm --filter @minecraft-studio/skills test
```

The native artifact blocker was resolved by building the existing Rust crate, and the full root gate passed. `scripts/measure-v2-baseline.mjs` runs synthetic arithmetic and is not evidence of Runtime or Rust performance. Minecraft bed/sign, survival and 60-minute residency acceptance remain unverified by these checks.

## Game identity and personal observations

The follow-up implements offline username BotIDs, authenticated Microsoft Java profile name/UUID bindings, managed Runtime Link assignments, and durable personal observations. See `docs/bot-personal-memory.md`. Before the protocol 775 dependency upgrade, the complete `pnpm check` passed with 585 Runtime tests, 607 Coordinator tests and 47 Manager/identity tests, plus the remaining workspace suites and builds. This gate covers software behavior and recovery fixtures; it does not establish survival readiness.

## Remaining stages

P3 must connect invitation and survey operations to the existing Coordinator/Runtime flow and persist bed/sign records through the authoritative storage path. P4/P5 must remove duplicate survival directors, expose the resource ledger through the existing control API, and complete external API capability checks. P6/P7 require isolated Minecraft evidence for movement, real bed respawn, machine protection, output consumption, restart recovery, and 60-minute residency. A successful login canary alone does not complete these stages.

