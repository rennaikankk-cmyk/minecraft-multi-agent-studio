use super::*;
use crate::world_mirror::{CellQuery, MirrorSession};
use crate::world_mirror_protocol::*;

fn scope() -> SemanticScope {
    SemanticScope {
        selector_revision: 1,
        bot_session_id: "test-session".into(),
        server_profile_id: "test-server".into(),
        dimension: "test:dimension".into(),
        minecraft_version: "test-version".into(),
    }
}
struct Driver {
    session: MirrorSession,
    sequence: u64,
}
impl Driver {
    fn new() -> Self {
        let mut d = Self {
            session: MirrorSession::new(1, 1),
            sequence: 0,
        };
        d.send(MirrorMessage::RegistryTable {
            revision: 1,
            masks: vec![1, 4, 4, 4, 0],
            minecraft_version: Some(scope().minecraft_version),
            server_profile_id: Some(scope().server_profile_id),
        });
        d.send(MirrorMessage::SemanticRegistryV1 {
            registry: SemanticRegistry {
                scope: scope(),
                selectors: vec![0, 1, 2, 3, 1],
            },
        });
        d
    }
    fn send(&mut self, message: MirrorMessage) -> MirrorAck {
        self.sequence += 1;
        self.session.submit_envelope(MirrorEnvelope {
            protocol_version: 1,
            session_epoch: 1,
            dimension_epoch: 1,
            transport_sequence: self.sequence,
            message,
        })
    }
    fn import(&mut self, chunk: (i32, i32), section_y: i32, states: Vec<u32>) {
        assert_eq!(
            self.send(MirrorMessage::ChunkBegin { chunk }).status,
            AckStatus::Applied
        );
        assert_eq!(
            self.send(MirrorMessage::SectionData {
                chunk,
                payload: SectionPayload::StateDataV1 {
                    section_y,
                    state_ids: states.into_boxed_slice()
                }
            })
            .status,
            AckStatus::Applied
        );
        assert_eq!(
            self.send(MirrorMessage::ChunkCommit { chunk }).status,
            AckStatus::Applied
        );
    }
    fn update(&mut self, position: (i32, i32, i32), state_id: u32, source: u64) -> MirrorAck {
        self.send(MirrorMessage::BlockUpdateBatch {
            source_first_sequence: source,
            source_last_sequence: source,
            source_event_count: 1,
            coalesced_event_count: None,
            updates: vec![BlockUpdateEntry { position, state_id }],
        })
    }
    fn query(&self, origin: (i32, i32, i32), radius: u32) -> SpatialResult {
        self.session
            .mirror()
            .snapshot_handle()
            .spatial_query(&query(origin, radius))
    }
}
fn query(origin: (i32, i32, i32), radius: u32) -> SpatialQuery {
    SpatialQuery {
        query_id: "q1".into(),
        session_epoch: 1,
        dimension_epoch: 1,
        scope: scope(),
        origin,
        radius,
        count: 256,
        selectors: 3,
        matching: SelectorMatch::Union,
        max_visits: MAX_QUERY_VISITS,
        max_ms: 10.0,
    }
}
fn local(x: i32, y: i32, z: i32) -> usize {
    (((y & 15) << 8) | ((z & 15) << 4) | (x & 15)) as usize
}

#[test]
fn per_selector_query_preserves_rare_interests_with_one_bounded_traversal() {
    let mut d = Driver::new();
    d.import((0, 0), 0, vec![0; 4096]);
    for (position, state) in [
        ((8, 8, 8), 1),
        ((7, 8, 8), 1),
        ((9, 8, 8), 1),
        ((12, 8, 8), 2),
    ] {
        d.update(position, state, 1);
    }
    let snapshot = d.session.mirror().snapshot_handle();
    let mut q = query((8, 8, 8), 5);
    q.count = 1;
    q.matching = SelectorMatch::Each;
    let result = snapshot.spatial_query(&q);
    assert_eq!(result.status, QueryStatus::Complete);
    assert_eq!(result.visited_entries, 4);
    assert_eq!(
        result
            .points
            .iter()
            .map(|p| (p.x, p.selectors))
            .collect::<Vec<_>>(),
        vec![(8, 1), (12, 2)]
    );
    d.update((8, 8, 8), 3, 2);
    let result = d.session.mirror().snapshot_handle().spatial_query(&q);
    assert_eq!(
        result.points.len(),
        1,
        "overlapping selectors must not duplicate a point"
    );
    q.selectors = SELECTOR_BITS;
    q.count = 11;
    assert_eq!(snapshot.spatial_query(&q).status, QueryStatus::InvalidQuery);
    q.count = 8;
    q.max_visits = 1;
    let exhausted = snapshot.spatial_query(&q);
    assert_eq!(exhausted.status, QueryStatus::BudgetExceeded);
    assert!(exhausted.points.is_empty());
}

#[test]
fn empty_promotes_and_old_membership_is_removed() {
    let mut d = Driver::new();
    d.send(MirrorMessage::ChunkBegin { chunk: (0, 0) });
    d.send(MirrorMessage::SectionData {
        chunk: (0, 0),
        payload: SectionPayload::Empty {
            section_y: 0,
            fill_state_id: 0,
        },
    });
    d.send(MirrorMessage::ChunkCommit { chunk: (0, 0) });
    assert_eq!(d.query((8, 8, 8), 2).status, QueryStatus::Complete);
    d.update((8, 8, 8), 1, 1000);
    let frozen = d.session.mirror().snapshot_handle();
    let old = d.query((8, 8, 8), 0);
    d.update((8, 8, 8), 2, 1);
    let now = d.query((8, 8, 8), 0);
    assert_eq!(now.points[0].selectors, 2);
    assert!(now.consulted_chunks[0].revision > old.consulted_chunks[0].revision);
    assert!(now.generation > old.generation);
    assert_eq!(
        frozen.spatial_query(&query((8, 8, 8), 0)).points[0].selectors,
        1
    );
    assert_eq!(
        d.session.mirror().snapshot_handle().query(8, 8, 8),
        CellQuery::Mask(4)
    );
    d.update((8, 8, 8), 0, 2);
    assert!(d.query((8, 8, 8), 0).points.is_empty());
    assert_eq!(d.session.mirror().memory_stats().index_entries, 0);
}

#[test]
fn radius_count_and_stable_order_union_intersection() {
    let mut d = Driver::new();
    d.import((0, 0), 0, vec![0; 4096]);
    for (pos, state) in [
        ((7, 8, 8), 1),
        ((9, 8, 8), 2),
        ((8, 7, 8), 3),
        ((8, 8, 9), 1),
        ((10, 8, 8), 3),
    ] {
        d.update(pos, state, 1);
    }
    let mut q = query((8, 8, 8), 1);
    q.count = 3;
    let snapshot = d.session.mirror().snapshot_handle();
    let r = snapshot.spatial_query(&q);
    assert_eq!(r.status, QueryStatus::Complete);
    assert_eq!(
        r.points.iter().map(|p| (p.x, p.y, p.z)).collect::<Vec<_>>(),
        vec![(7, 8, 8), (8, 7, 8), (8, 8, 9)]
    );
    q.matching = SelectorMatch::Intersection;
    assert_eq!(
        snapshot
            .spatial_query(&q)
            .points
            .iter()
            .map(|p| (p.x, p.y, p.z))
            .collect::<Vec<_>>(),
        vec![(8, 7, 8)]
    );
}

#[test]
fn boundaries_negative_height_and_unknown_are_distinct() {
    let mut d = Driver::new();
    for cx in -1..=0 {
        for cz in -1..=0 {
            d.import((cx, cz), -1, vec![0; 4096]);
        }
    }
    d.update((-1, -8, 0), 1, 1);
    d.update((0, -8, -1), 2, 2);
    let r = d.query((0, -8, 0), 2);
    assert_eq!(r.status, QueryStatus::Complete);
    assert_eq!(r.points.len(), 2);
    d.update((0, -8, 0), 4, 3); // registry movement zero is UNKNOWN
    assert_eq!(d.query((0, -8, 0), 2).status, QueryStatus::Incomplete);
    assert_eq!(d.query((0, -8, 0), 2).points.len(), 2);
    d.update((0, -8, 0), u32::MAX, 4);
    assert_eq!(
        d.session.mirror().snapshot_handle().query(0, -8, 0),
        CellQuery::Mask(CLASS_UNKNOWN_BIT)
    );
    assert_eq!(d.query((0, 8, 0), 0).status, QueryStatus::Incomplete);
    assert_eq!(d.query((64, 8, 0), 0).status, QueryStatus::Incomplete);
}

#[test]
fn import_queue_unload_late_updates_and_reset_do_not_leak() {
    let mut d = Driver::new();
    d.import((0, 0), 0, vec![0; 4096]);
    d.send(MirrorMessage::ChunkBegin { chunk: (0, 0) });
    d.send(MirrorMessage::SectionData {
        chunk: (0, 0),
        payload: SectionPayload::StateDataV1 {
            section_y: 0,
            state_ids: vec![0; 4096].into_boxed_slice(),
        },
    });
    assert_eq!(
        d.update((8, 8, 8), 2, 300).status,
        AckStatus::QueuedUntilCommit
    );
    d.update((8, 8, 8), 1, 200);
    assert_eq!(d.query((8, 8, 8), 0).status, QueryStatus::Incomplete);
    d.send(MirrorMessage::ChunkCommit { chunk: (0, 0) });
    assert_eq!(d.query((8, 8, 8), 0).points[0].selectors, 2);
    d.send(MirrorMessage::ChunkUnload { chunk: (0, 0) });
    assert_eq!(d.update((8, 8, 8), 1, 400).skipped_updates, Some(1));
    assert!(d.query((8, 8, 8), 0).points.is_empty());
    assert_eq!(d.session.mirror().memory_stats().index_entries, 0);
    d.session.submit_control(&MirrorControl::WorldReset {
        new_session_epoch: 2,
        new_dimension_epoch: 2,
        reason: WorldResetReason::DimensionChange,
        resync_token: 1,
    });
    assert_eq!(d.query((8, 8, 8), 0).status, QueryStatus::ScopeMismatch);
    let mut q = query((8, 8, 8), 0);
    q.session_epoch = 2;
    q.dimension_epoch = 2;
    assert_eq!(
        d.session
            .mirror()
            .snapshot_handle()
            .spatial_query(&q)
            .status,
        QueryStatus::NotReady
    );
}

#[test]
fn legacy_data_is_unavailable_and_not_present_does_not_become_air() {
    let mut d = Driver::new();
    d.send(MirrorMessage::ChunkBegin { chunk: (0, 0) });
    d.send(MirrorMessage::SectionData {
        chunk: (0, 0),
        payload: SectionPayload::Data {
            section_y: 0,
            palette_indices: vec![0; 4096].into_boxed_slice(),
            palette_entries: vec![1],
        },
    });
    d.send(MirrorMessage::ChunkCommit { chunk: (0, 0) });
    d.update((8, 8, 8), 1, 1);
    assert_eq!(d.query((8, 8, 8), 0).status, QueryStatus::Incomplete);
    assert!(d.query((8, 8, 8), 0).points.is_empty());
    assert_eq!(d.update((8, -8, 8), 1, 2).skipped_updates, Some(1));
    assert_eq!(
        d.session.mirror().snapshot_handle().query(8, -8, 8),
        CellQuery::SectionNotPresent
    );
}

#[test]
fn invalid_queries_and_scope_fences() {
    let d = Driver::new();
    let s = d.session.mirror().snapshot_handle();
    for invalid in 0..8 {
        let mut q = query((8, 8, 8), 0);
        match invalid {
            0 => q.radius = 97,
            1 => q.count = 257,
            2 => q.count = 0,
            3 => q.max_ms = f64::NAN,
            4 => q.max_visits = MAX_QUERY_VISITS + 1,
            5 => q.selectors = CLASS_UNKNOWN_BIT,
            6 => q.origin.0 = i32::MAX,
            _ => q.query_id.clear(),
        }
        assert_eq!(s.spatial_query(&q).status, QueryStatus::InvalidQuery);
    }
    for changed in 0..5 {
        let mut q = query((8, 8, 8), 0);
        match changed {
            0 => q.scope.server_profile_id.push('x'),
            1 => q.scope.dimension.push('x'),
            2 => q.scope.bot_session_id.push('x'),
            3 => q.scope.minecraft_version.push('x'),
            _ => q.dimension_epoch += 1,
        }
        assert_eq!(s.spatial_query(&q).status, QueryStatus::ScopeMismatch);
    }
}

#[test]
fn exhausted_work_or_time_does_not_claim_nearest_results() {
    let mut d = Driver::new();
    d.import((0, 0), 0, vec![1; 4096]);
    let mut q = query((8, 8, 8), 4);
    q.max_visits = 1;
    let r = d.session.mirror().snapshot_handle().spatial_query(&q);
    assert_eq!(r.status, QueryStatus::BudgetExceeded);
    assert!(r.points.is_empty());
    assert_eq!(r.visited_entries, 1);
    q.max_visits = MAX_QUERY_VISITS;
    q.max_ms = f64::MIN_POSITIVE;
    assert_eq!(
        d.session
            .mirror()
            .snapshot_handle()
            .spatial_query(&q)
            .status,
        QueryStatus::BudgetExceeded
    );
}

#[test]
fn registry_semantic_payload_is_fingerprinted_and_scope_bound() {
    let mut d = Driver::new();
    let a = MirrorMessage::SemanticRegistryV1 {
        registry: SemanticRegistry {
            scope: scope(),
            selectors: vec![0, 1, 2, 3, 1],
        },
    };
    let mut b = a.clone();
    if let MirrorMessage::SemanticRegistryV1 { registry } = &mut b {
        registry.scope.server_profile_id.push('x');
    }
    assert_ne!(payload_fingerprint(&a), payload_fingerprint(&b));
    assert_eq!(d.send(a).status, AckStatus::RegistryReady);
    assert_eq!(d.send(b).status, AckStatus::ResetRequired);
    assert_eq!(d.query((8, 8, 8), 0).status, QueryStatus::Desynced);
    let raw = MirrorMessage::SectionData {
        chunk: (0, 0),
        payload: SectionPayload::StateDataV1 {
            section_y: 0,
            state_ids: vec![0; 4095].into_boxed_slice(),
        },
    };
    assert!(validate_message_structure(&raw).is_err());
}

#[test]
fn high_state_ids_do_not_overflow_u16_palette() {
    let mut session = MirrorSession::new(1, 1);
    let mut masks = vec![1; 70_001];
    masks[70_000] = 4;
    let messages = vec![
        MirrorMessage::RegistryTable {
            revision: 1,
            masks,
            minecraft_version: None,
            server_profile_id: None,
        },
        MirrorMessage::ChunkBegin { chunk: (0, 0) },
        MirrorMessage::SectionData {
            chunk: (0, 0),
            payload: SectionPayload::Empty {
                section_y: 0,
                fill_state_id: 0,
            },
        },
        MirrorMessage::ChunkCommit { chunk: (0, 0) },
        MirrorMessage::BlockUpdateBatch {
            source_first_sequence: 1,
            source_last_sequence: 1,
            source_event_count: 1,
            coalesced_event_count: None,
            updates: vec![BlockUpdateEntry {
                position: (8, 8, 8),
                state_id: 70_000,
            }],
        },
    ];
    for (i, message) in messages.into_iter().enumerate() {
        session.submit_envelope(MirrorEnvelope {
            protocol_version: 1,
            session_epoch: 1,
            dimension_epoch: 1,
            transport_sequence: i as u64 + 1,
            message,
        });
    }
    assert_eq!(
        session.mirror().snapshot_handle().query(8, 8, 8),
        CellQuery::Mask(4)
    );
    assert_eq!(session.mirror().memory_stats().palette_entries, 2);
}

#[test]
fn pending_and_loaded_capacity_fail_closed_then_reset_reclaims() {
    let mut d = Driver::new();
    for x in 0..MAX_PENDING_CHUNKS {
        assert_eq!(
            d.send(MirrorMessage::ChunkBegin {
                chunk: (x as i32, 0)
            })
            .status,
            AckStatus::Applied
        );
    }
    assert_eq!(
        d.send(MirrorMessage::ChunkBegin { chunk: (999, 0) }).reason,
        Some(AckReason::CapacityExceeded)
    );
    let mut d = Driver::new();
    for x in 0..MAX_LOADED_CHUNKS {
        d.import((x as i32, 0), 0, vec![0; 4096]);
    }
    d.send(MirrorMessage::ChunkBegin { chunk: (999, 0) });
    assert_eq!(
        d.send(MirrorMessage::ChunkCommit { chunk: (999, 0) })
            .reason,
        Some(AckReason::CapacityExceeded)
    );
    d.session.mirror_mut().reset(2, 2);
    assert_eq!(d.session.mirror().memory_stats().chunks_loaded, 0);
    assert_eq!(d.session.mirror().memory_stats().index_entries, 0);
}

#[test]
fn property_incremental_index_equals_final_rebuild() {
    for seed in [1_u64, 42, 1337, 90210] {
        let mut rng = seed;
        let mut d = Driver::new();
        let mut states = vec![0_u32; 4096];
        d.import((-1, 0), -1, states.clone());
        for step in 0..2000 {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            let pos = (
                -16 + (rng % 16) as i32,
                -16 + ((rng >> 4) % 16) as i32,
                ((rng >> 8) % 16) as i32,
            );
            let state_id = ((rng >> 12) % 7) as u32;
            states[local(pos.0, pos.1, pos.2)] = state_id;
            d.update(pos, state_id, step);
        }
        let mut rebuilt = Driver::new();
        rebuilt.import((-1, 0), -1, states);
        for radius in [0, 2, 5, 7, 16] {
            let a = d.query((-8, -8, 8), radius);
            let b = rebuilt.query((-8, -8, 8), radius);
            assert_eq!(a.status, b.status, "seed={seed} radius={radius}");
            assert_eq!(a.points, b.points, "seed={seed} radius={radius}");
        }
        assert_eq!(
            d.session.mirror().memory_stats().index_entries,
            rebuilt.session.mirror().memory_stats().index_entries
        );
    }
}

#[test]
fn sparse_index_hard_capacity_has_no_silent_eviction() {
    let mut d = Driver::new();
    for x in 0..8 {
        d.send(MirrorMessage::ChunkBegin { chunk: (x, 0) });
        for section_y in 0..64 {
            d.send(MirrorMessage::SectionData {
                chunk: (x, 0),
                payload: SectionPayload::Empty {
                    section_y,
                    fill_state_id: 1,
                },
            });
        }
        assert_eq!(
            d.send(MirrorMessage::ChunkCommit { chunk: (x, 0) }).status,
            AckStatus::Applied
        );
    }
    assert_eq!(
        d.session.mirror().memory_stats().index_entries,
        MAX_INDEX_ENTRIES
    );
    d.import((8, 0), 0, vec![0; 4096]);
    assert_eq!(
        d.update((128, 0, 0), 1, 1).reason,
        Some(AckReason::CapacityExceeded)
    );
    assert_eq!(
        d.session.mirror().memory_stats().index_entries,
        MAX_INDEX_ENTRIES
    );
    assert_eq!(d.query((0, 0, 0), 0).status, QueryStatus::Desynced);
    d.session.mirror_mut().reset(2, 2);
    assert_eq!(d.session.mirror().memory_stats().index_entries, 0);
}
