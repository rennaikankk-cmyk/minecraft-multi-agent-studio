# Unified Takeover: Offline Validation

Date: 2026-09-06. This stage performs no Spark requests and no Minecraft connections.
GLM delivery `bca26e1e13118dfae173ff7601d5a28d9bd9874a` and its four commits are retained through a merge, not rewritten.

## Rust Stage (Already Merged Independently)

- Repair: `f98d89b949cb83af7e58c70fdc430e0ba24d3308`.
- Native smoke candidate: `b1fd1e0036af3a48aee92bc924219f155b27bce7`.
- Main merge: `8053325daa93b58e4a6f09b85af54d2be48d7988`, [PR #10](https://github.com/rennaikankk-cmyk/minecraft-multi-agent-studio/pull/10).
- Candidate Ubuntu CI: [CI](https://github.com/rennaikankk-cmyk/minecraft-multi-agent-studio/actions/runs/34019863384), [quality gates](https://github.com/rennaikankk-cmyk/minecraft-multi-agent-studio/actions/runs/34019863429), both PASS.
- Actual main SHA CI: [CI](https://github.com/rennaikankk-cmyk/minecraft-multi-agent-studio/actions/runs/34020348507), [quality gates](https://github.com/rennaikankk-cmyk/minecraft-multi-agent-studio/actions/runs/34020348580), both PASS.
- Ubuntu gates run cargo fmt, all 48 Rust tests, release addon build, real native and worker export smoke, full pnpm check. Quality gates also run authenticated Runtime Link, four-process acceptance and real PostgreSQL/Redis tests.
- Windows: initial cargo test failed because dlltool.exe was absent from PATH. With the installed GNU bin directory in PATH, cargo fmt/test (48), release addon and native smoke passed; full pnpm check passed. Local pnpm was 11.19.0; CI used the repository pin 11.9.0. No lockfile changed.
- Pure logic tests remain internal cfg(test) modules. External integration tests still compile the non-test library; cfg(test) does not universally isolate them from N-API.
- Rollback: revert main merge with `git revert -m 1 8053325daa93b58e4a6f09b85af54d2be48d7988` on a reviewed branch. This restores the original Linux test failure as well.

## Counterexamples and Fixes

Before changing implementation, the original 35 module tests passed and all 7 added counterexamples failed. They cover the five requested defects (task/facility unknown and goal/alternative validation each have separate counterexamples).

1. Trusted action rules derive required construction gates. Model gates only add constraints. Existing blueprint files, parser kinds, runtime skill definitions and parameter schemas determine what the action means. Missing trusted rules reject; missing gate observations request reobservation. Unrelated gates do not block food or scanning.
2. Task unknown requests reobservation. Non-preemptible claims contradicting idle/unknown reject actions. Busy facilities need known ownership; other holders reject. Wait/noop remains possible when unknown fields are not action dependencies.
3. Fact version, observed/captured age, future skew, timestamp relationships, proposal expiry and TTL are separate checks. Defaults: 180s fact age, 180s TTL from capture, 2s clock skew. The 180s observation envelope accommodates the existing 120s model deadline plus queue/transport headroom, not execution freshness. Trusted callers can tighten it. Replay requires an explicit clock and never refreshes historical timestamps.
4. The actual model text reserves mandatory constraints before optional events/inventory. Default remains 4000 chars; insufficient mandatory budget throws. Statistics describe discarded optional records, compressed events and post-window formatted characters omitted by limits/budget; sections reflect the emitted text.
5. Primary and failure alternatives use the same action/schema/gate/resource checks. Target coordinates remain in trusted local context and never in the proposal/summary. Blueprint and movement references must resolve within scope. Unsupported skill interfaces fail explicitly instead of being assumed usable.

## Verification

- `pnpm --filter @minecraft-studio/coordinator exec vitest run tests/spark-strategy-v1`: 87 passed, including 7 reproduced counterexamples and 45 further boundary/valid-action tests.
- `pnpm --filter @minecraft-studio/coordinator typecheck`: PASS.
- `pnpm --filter @minecraft-studio/coordinator test`: 567 Vitest tests plus 5 Node tests passed; no skips.
- `pnpm --filter @minecraft-studio/coordinator build`: PASS.
- `node eval/spark-strategy-v1/run-offline.mjs --out runtime-data/spark-strategy-v1/takeover-offline`: 5 injected responses, 4 parsed proposals, 3 validator acceptances, 1 scope rejection, 1 expected parse failure, 4 parsed cases matching behavior/verdict expectations, 1 correct waiting case. These are not Minecraft task successes.

## Limits and Next Stage

This validator does not acquire leases, validate physical reach/material delivery, or execute assignments. Acquisition goals are recognized through the existing ResourceGraph; downstream decomposition and grounding remain the actual planner's responsibility. A valid proposal is eligible only for further review.

Direct skills currently supported by this proposal interface are food.secure, world.scan, collect.block, craft.item, container.transfer, movement.goto and inventory.equip-armor. Other registered skills are not automatically trusted. All five original goal templates have real-parser tests; complex building uses reviewed blueprint files, not model-authored cells. New blueprint names require a trusted gate rule.

Production observation wiring, D3, Spark live quality/capacity, automatic dispatch and real Minecraft execution are not evidence from this stage. Automatic strategy dispatch remains OFF. Stage-specific commit/PR/main SHAs and later gates are recorded in the final takeover report.
