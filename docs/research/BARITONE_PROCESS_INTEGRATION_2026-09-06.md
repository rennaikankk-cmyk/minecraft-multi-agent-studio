# Baritone Process Integration

This change adds bounded Mineflayer implementations corresponding to Baritone public process families. It does not install the Java Baritone runtime, reproduce every command/setting, or establish real-server readiness. The reference remains cabaletta/baritone revision `23723891da460ef15797b02fe5b385b0c5b163cc`; no Baritone implementation was copied or translated.

## Capability And Evidence Matrix

| Baritone family | Studio entry | Implemented behavior | Remaining limits |
|---|---|---|---|
| CustomGoal | movement.goto, travel.route, movement.goal | Existing travel plus block/near/XZ/Y/adjacent/runaway goals, any/all and inversion | Mineflayer bounded searches; not Baritone path precomputation/splicing |
| Mine | collect.block, mine.branch, mine.vein | Existing acquisition/mining paths now consult the shared asset authority | No new ore-cache engine or Baritone mining scheduler in this change |
| Builder | build.blueprint, build.clear-area, schematic importer | Existing fixed-anchor build journal; bounded clearing; Sponge v2/MCEdit parser; rotation, mirroring, selection clipping, simple material replacement | No arbitrary blockstate repair, entity NBT, Litematic, or complete selection-command system; unsupported transformed properties are rejected |
| Farm | farm.maintain | Maturity rules for 11 crop types, reserved replant actions/seeds, stem-base preservation, ground planting, supported bonemeal, inventory deltas | Not tilling, irrigation, farm construction, automatic economic scheduling, or food throughput evidence; empty cocoa-log planting is not implemented |
| Explore | world.explore | Bounded chunk target selection/exclusions, current loaded observations, partial outcomes | No persistent Baritone region cache; caller checkpoints cannot prove unloaded chunks observed |
| GetToBlock | movement.get-to-block | Rescan candidates, bounded approach, final target verification | No automatic right click; container/workstation effects remain separate skills |
| Follow | movement.follow | Dynamic entity goals, bounded interval, identity/loss/range checks, proximity duration | No success if never close; not indefinite background following or pickup-process parity |
| Elytra | movement.elytra | Mineflayer/Prismarine physics, equipped usable elytra, loaded straight descent corridor, grounded arrival verification | Airborne start; no rocket routing, automated takeoff, complex detours, or long-distance flight validation |

Seven new registered skills bring the catalog to 30. New skills are Partial: offline tests and Runtime wiring exist; isolated Minecraft scenario and cross-version evidence remain absent. This work does not complete P5-D3, P5-E, or the remaining P5 performance gates.

## Shared Effects And Lifecycle

Coordinator is the sole provenance file writer. Runtime observes the shared authority before digging, checks team/base protection, and records uncertain placements before sending them. Confirmed placement updates and confirmed dig removals use the same authority. Production uses `runtime-data/provenance`; malformed/mixed-scope/capacity-exhausted strict stores fail closed.

New snapshots use `by-profile/<sha256-of-exact-profile-id>.json` to separate case/punctuation variants on Windows. Legacy snapshots are read with strict profile validation and canonical dimension migration; the original file is preserved. Conflicting duplicate positions are rejected.

Unknown blocks inside the conservative base guard or registered blueprint bounds remain protected. Build journal registration expands protected bounds before dispatch. Existing placement metadata cannot be downgraded from structural to disposable merely by a movement lease.

Farm/clear operations claim overlapping cuboids atomically, renew every 5 seconds with a 30-second TTL, and locally abort when renewal stalls. Asset writes/digs respect another operation's region. Minecraft does not enforce these tokens: already-sent effects still need server confirmation and world reinspection; lease expiry is not proof of remote quiescence.

MovementController remains the sole movement owner, with L0 priority. New operations stop on cancellation, preemption, disconnect or scope change. Restoring both dig and placement wrappers prevents accumulation across successive skills. Long crop scans yield even when all cells are skipped/unknown.

Interruption and wrapper teardown invalidate escaped effect callbacks. Effects capture their region token and recheck dimension after authority requests. L0 movement preempts immediately; L0 foraging returns a busy receipt until a pending world/inventory effect releases its resource lock, then retries with its own wrapper. Crop pickup uses a separate close-range goal rather than the harvesting interaction range; inventory receipts remain measured deltas.

Partial/waiting process receipts do not become successful Coordinator goals. They project stable PROCESS_* failure codes; the current planner terminates that attempt instead of automatically running a durable continuation. Reinvocation reobserves the world. This is not a perpetual farm controller or a new durable process journal.

Deploy Coordinator and Runtime together after stopping older Runtime instances that still write provenance files directly. No deployment or external server login was performed by this change.

## Schematic Import

Dependencies pinned in pnpm-lock.yaml: `prismarine-schematic@1.3.0` (PrismarineJS, MIT), `prismarine-nbt@2.8.0`. Import is offline and bounded: 2 MB source, 4 MB decompressed, 4096-cell volume, at most 512 resulting blueprint cells. Nonempty entity/block-entity NBT, unsupported versions/transform properties, palette mismatches and invalid staging are rejected. Air is omitted, not implicitly cleared.

Build Coordinator, then run:

```text
node scripts/import-schematic.mjs source.schem options.json destination.json
```

Options include explicit minecraftVersion, name, batchSize and staging; optional rotate (0/90/180/270), mirror (none/x/z), selection bounds and replacements. Output uses the existing blueprint-file format and preserves required block properties through dispatch. Destination must not already exist. A successfully imported blueprint is not proof that every state can be placed by the current builder.

`mineflayer-elytrafly@1.4.8` was inspected but not installed: direct velocity modification and incomplete listener/timer cleanup do not meet this Runtime's ownership/cancellation contract.

## Rust Decision

Keep TypeScript/Mineflayer for protocol, control, inventory and skill orchestration; retain the existing Rust pathfinder behind its current feature gate. No new Rust was added, and no performance improvement is claimed. A full Rust rewrite would require replacing the client protocol/physics integration and would not automatically provide Baritone's Java/client capabilities. Move additional spatial computation only after the established event-loop/performance measurements identify a bottleneck.

## Validation Scope

Final local verification on 2026-09-06: `corepack pnpm check` exited 0 (typechecks, 2733 Vitest tests passed, 38 explicitly skipped, 41 Node tests passed, workflow policy validation, and builds). `cargo fmt --manifest-path packages/pathfinder-rs/Cargo.toml --check` and `cargo test --manifest-path packages/pathfinder-rs/Cargo.toml --locked` passed; Rust reported 48 tests passed. The native addon rebuilt successfully, followed by 19 passing world-sync adapter/stress tests against the refreshed addon. Skipped infrastructure/Minecraft gates are not success evidence.

Tests cover process schemas and L0 preconditions; crop maturity/seed reserve/replant verification; cancellation; full clear-area reinspection; goal predicates and final arrival; lost targets; unknown exploration chunks; bounded elytra equipment/landing behavior; shared HTTP assets, persistence and region conflicts; lease renewal/stall expiry; schematic conversion and rejection; partial-goal projection; and the existing Runtime/Coordinator regressions. These are offline/fake-world or loopback HTTP tests, not Minecraft server success evidence.

The real-isolated-server test now starts its own authenticated loopback shared-state authority with temporary persistence, overriding and restoring shared-state environment variables for the suite. It does not reuse any running production authority. Minecraft acceptance was not executed: the checked local Java installations are Java 8 and the isolated runtime has no Java 21. The existing 1.21.8 server JAR matches its pinned SHA-256, and its EULA file was already accepted; neither the EULA nor production profiles were changed.
