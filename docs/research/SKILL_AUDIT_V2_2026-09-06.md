# Skill Audit, Development v2

Baseline catalog: 31 registered skills. Sources were reviewed through the SDK, actual Runtime capability dispatch, Coordinator dispatch and successful-output interpretation. Counts and maturity come from the generated manifest, not this audit. All Minecraft version claims require scenario evidence; portable compatibility means registry/protocol checks can select an implementation, not a verified cross-version matrix.

## Shared Boundaries

- `packages/skills/src/types.ts`, registry/executor, compatibility resolver: schema, explicit capability authorization, cancellation, timeout and retry policy. Non-idempotent operations do not automatically retry.
- `apps/coordinator/src/local-planner.ts`: advertised catalog/input checks, trusted server scope, task FSM and assignment, safety wait, execution generation, durable build journal and common deterministic/model dispatch.
- `apps/bot-runtime/src/mineflayer-client.ts`: Runtime actions, inventory/crafting/container locks, server readbacks, canonical workstation leases, shared world asset/work-area authority and movement ownership.
- `process-completion.ts`: a completed RPC can still leave its world objective pending. This revision adds partial container/sort/pack receipts and unmet food targets to that distinction.
- One action's result does not prove indefinite production, reserve ownership after death, facility operation, or delivery to another Bot. Recovery must inspect current server facts before repeating uncertain side effects.

## All Registered Skills

Source paths below are relative to `packages/skills/src`; Runtime paths are relative to `apps/bot-runtime/src`. D = deterministic template plus advertised planner, P = advertised planner; P does not imply Spark team proposals have permission. The separate trusted action rules remain authoritative.

| Skill | Source / Runtime Consumer | Reach | Verification and Recovery | Remaining Boundary |
| --- | --- | --- | --- | --- |
| movement.goto | builtin/movement-goto.ts / invokeMovementGoto | D | Arrival distance, bounded path, exclusive movement token, scope/cancel | Loaded route and policy reach; no network latency guarantee |
| travel.route | builtin/travel-route.ts / route segment adapter | P | Scoped waypoint plan, bounded segment arrival | Portal travel and multi-version routes need scenario matrix |
| movement.goal | baritone-processes.ts / navigation-process-adapter.ts | P | Goal predicate readback, finite search, one movement owner | Complex world changes require reobserve |
| movement.follow | baritone-processes.ts / followEntity | P | Pinned entity identity, near-duration, target loss and bounded interval | Following is not attack success |
| movement.get-to-block | baritone-processes.ts / getToBlock | P | D4 query, approach, exact live block, cancel after awaits | Unknown coverage cannot prove absence |
| movement.elytra | baritone-processes.ts / elytra-process-adapter.ts | P | Equipped wings, durability, rocket delta, cruise/landing readback | Isolated-test only; complete flight/cancel and complex detours unverified |
| movement.profile | planning/movement-profile.ts / profile adapter | P | Applied deterministic profile receipt | Configuration acknowledgment, not a traversal proof |
| inventory.equip-armor | builtin/equip-armor.ts / armor.snapshot, armor.equip | D | Inventory lock, best-slot selection, equipment readback | Enchantment scoring/protocol matrix needs real versions |
| combat.engage | builtin/combat-control.ts / combat-driver.ts | P | Deterministic identity and survivability; actual disposition receipt | Intent acknowledgment is not target damage/kill; reflex PvP timing gate remains |
| combat.disengage | builtin/combat-control.ts / combat-driver.ts | P | Suppresses offense, actual retreat/disengage receipt; allowed during normal-task pause | Escape location and resumed production need composite evidence |
| combat.stance | builtin/combat-stance.ts / combat driver | D | Bounded applied stance; explicit capability and server scope | Does not change the whitelist or prove combat strength |
| world.scan | builtin/scan-blocks.ts / invokeScanBlocks | D | Indexed candidates, live reach/readback, explicit completeness | D4 optional flag, unsupported names get bounded incomplete compatibility probe |
| world.explore | baritone-processes.ts / exploreChunks | D | Loaded chunk observations, scoped durable Coordinator exploration journal | Cached visited claims never replace current world evidence |
| collect.block | builtin/collect-block.ts / invokeCollectBlocks | D | Harvestable tools, reachable targets, server block updates and pickup delta, bounded alternatives | Full bag/tool break/unknown chunk require replan; no infinite retry |
| mine.branch | planning/mine-planner.ts / invokeMinePlan | P | Finite dig plan, live target and block removal, scope/safety | Output is a verified executed dig plan, not an acquired-item receipt; narrow named-block tunnel semantics |
| mine.vein | planning/mine-planner.ts / invokeMinePlan | P | Explicit ore positions, bounded sequence and return; local verification | Same output limitation; current observations required after interruption |
| craft.item | builtin/craft-item.ts / invokeCraftItem | D | Version registry recipes, material deltas, station lease/reuse, output delta | Incomplete station discovery cannot authorize duplicate placement |
| smelt.item | builtin/smelt-item.ts / invokeSmeltItem | D | Exclusive leased furnace, exact owned input/fuel/output, inventory receipt | Unknown/lost transaction needs reconciliation before refeed |
| world.place-block | builtin/place-block.ts / invokePlaceBlock | P | Fixed target cell, alternate support preserves target, expected block type readback | Unsupported item-to-block conversions reject; not arbitrary terrain preparation |
| build.blueprint | planning/blueprint-planner.ts / inspectBlueprintWorkset, placement | D | Fixed file blueprint identity, actual deficits, finite batches, whole-cell readback, durable journal | Blueprint completion alone does not establish production |
| build.clear-area | baritone-processes.ts / withAreaProcess | P | Shared area lease, explicit names, safe dig and whole-area recheck | Fluids/falling blocks/unknown neighbors pause, no fabricated clear area |
| site.assess | planning/site-assessor.ts / invokeSiteObservation | D | Loaded terrain/footprint facts and deterministic base rules | Observation is suitability evidence, not infrastructure readiness |
| shelter.dig | planning/site-assessor.ts / site-shelter-adapter.ts | D | Bounded tunnel/seal, server block evidence, cancellation | Local emergency shelter, not a defended permanent base |
| container.transfer | builtin/container-transfer.ts / invokeContainerTransfer | P | Canonical double-chest lease, both inventory deltas after reopen, own-window cleanup | Uncertain receipt blocks blind replay; external actors can invalidate snapshots |
| store.sort | planning/stock-levels.ts / container.transfer-safe | P | Per-route receipt, partial route stays pending, residual-only continuation | Persist each receipt; use maxTransfers=1 when crash recovery needs per-transfer checkpoints |
| pack.shulker | planning/stock-levels.ts / container.transfer-safe | P | Actual shulker required; partial item retains residual and cannot complete | Packing is not pickup/delivery of the shulker itself |
| stock.levels | planning/stock-levels.ts | P | Pure deterministic arithmetic over supplied counts | Experimental; no server observation or stock ownership proof |
| food.secure | builtin/secure-food.ts / secureSafeFood, forageRound | D | Net inventory progress, bounded rounds, parent cancellation, reserve-aware count | Short resupply, not long-term self-sufficiency |
| farm.maintain | farm-maintenance.ts / createFarmPort | P | Maturity/substrate, real harvest/replant, seed reservation, area lease | Maintenance requires prepared suitable land |
| farm.sustain | farm-sustain.ts / createFoodFarmPort, farm-storage.ts | D | Water/light/fence readback, planting, reserves, dual storage readback, finite pass; production windows now accept authoritative consumption telemetry | Natural multi-cycle production and supply/demand soak remain external gates |
| trade.villager | builtin/trade-villager.ts / villager-trading.ts | P | Exact live identity including UUID, leased work area, fresh merchant offers and exact payment/output | Single trade does not prove workstation binding/restock or full trading hall |

## High-Priority Corrections

1. Sorting/packing advanced their cursor on zero or partial transfers. They now retain the current entry and return its residual; mismatched receipts reject. The task layer also preserves the incomplete objective.
2. Generic transfer accepted inventory loss as delivery. It now reopens the server window and requires equal opposite deltas; ambiguous results are non-retryable until observed. Late close callbacks check exact window ownership. A barrel/chest cannot satisfy pack.shulker.
3. Proactive forage omitted the parent abort signal and reused "any food exists" as progress, permitting empty repeat rounds. It now checks net gain, bounds rounds, propagates cancellation and checks ownership before stopping paths. A pickup larger than the target is valid; reserved seeds are excluded from usable counts.
4. Placement's alternate-support path could move the target cell and accepted any final non-air block. It now preserves the exact target and checks supported block variants.
5. Manifest annotations lagged real file-blueprint/exploration persistence and deterministic farm/site reachability. They now describe source behavior; maturity remains evidence-derived.

6. Vanilla 1.21.4+ can ignore initial item/block interaction until `player_loaded`. Locked Mineflayer 4.37.1 omits that packet (upstream PR3960/3986). `player-loaded.ts` checks the negotiated empty packet schema and sends before ordinary spawn consumers, including respawn; older protocols send nothing. Remove the adapter when the dependency owns this lifecycle fix.

Combat audit follows `pursuit-controller.ts`, `combat-driver.ts`, `combat-mineflayer-adapter.ts` and `packages/combat/src/identity.ts`: entity object/UUID identity, target disappearance, engagement/retreat checks, attack epochs and movement priority remain deterministic. Nearby skeleton/stray/bogged mobs and non-whitelisted players holding a bow/crossbow now trigger a bounded shield action when health is low and a shield is observed. This is a deterministic defensive reaction, not a claim of proven sub-50ms reflex combat or guaranteed projectile interception under network loss.

## Validation Status

Skill schema/receipt regression tests and focused Runtime tests passed; Coordinator582 + Node5 tests passed. Retained early isolated runs failed at open-window timeout. Packet traces established the missing `player_loaded` cause; run `skill-reliability-1788696398791-6a5e9528` passed after the fix, including cleanup. It proves real Runtime partial delivery, duplicate invocation, residual continuation, wrong-container rejection, two-Bot contention and 64-item food pickup. Fixture platform/materials/daylight and dropped food were injected; authorities were explicitly shared in-memory instances in the test process. This is development evidence from an uncommitted tree, not fixed-SHA canary evidence. The full-check action-lock fixture was updated to model the newly required dual inventory readback; its five tests pass.

Core composite chains A-F are a separate implementation stage. Natural crop/tree regeneration, villager restock, large facility expansion, original long matrices and external G0-G6 are not represented as passed by these short tests.
