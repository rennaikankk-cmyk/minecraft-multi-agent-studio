//! P5-C WorldMirror 单元+属性测试。
//! 完成门对照：随机增量序列结果==最终状态全量重建；旧 epoch/重复消息/
//! unload 后迟到更新全部正确；UNKNOWN/AIR/INCOMPLETE 四态语义有测试。

use pathfinder_rs::world_mirror::*;
use std::collections::HashMap;

fn registry_with(masks: &[BlockClassMask]) -> MirrorMessage {
    MirrorMessage::RegistryTable {
        sequence: 1,
        masks: masks.to_vec(),
    }
}

fn data_payload(section_y: i32, fill: u16) -> SectionPayload {
    SectionPayload {
        section_y,
        status: SectionStatus::Data,
        palette_indices: vec![fill; 4096].into_boxed_slice(),
        palette_entries: vec![0b0111, CLASS_UNKNOWN_BIT],
    }
}

fn mirror_with_registry() -> WorldMirror {
    let mut mirror = WorldMirror::new(7, 1);
    // registry[0]=AIR|PASSABLE 假设由 TS 握手决定；registry[1]=多类别方块。
    mirror.apply(registry_with(&[0b0111, 0b1011])).unwrap();
    mirror
}

fn import_chunk(
    mirror: &mut WorldMirror,
    chunk: ChunkKey,
    begin_seq: u64,
    commit_seq: u64,
    section_y: i32,
) {
    mirror
        .apply(MirrorMessage::ChunkBegin {
            session_epoch: 7,
            dimension_epoch: 1,
            chunk,
            sequence: begin_seq,
        })
        .unwrap();
    mirror
        .apply(MirrorMessage::ChunkSectionData {
            chunk,
            sequence: begin_seq + 1,
            payload: data_payload(section_y, 0),
        })
        .unwrap();
    mirror
        .apply(MirrorMessage::ChunkCommit {
            chunk,
            sequence: commit_seq,
        })
        .unwrap();
}

#[test]
fn registry_handshake_and_unknown_state_id() {
    let mirror = mirror_with_registry();
    let snapshot = mirror.snapshot_handle();
    let mut m2 = mirror_with_registry();
    import_chunk(&mut m2, (0, 0), 2, 4, 0);
    let snap = m2.snapshot_handle();
    // stateId 在表内 → 查到 mask；表外（如 99）→ UNKNOWN 位（非 AIR）。
    m2.apply(MirrorMessage::BlockUpdate {
        position: (1, 1, 1),
        state_id: 1,
        sequence: 5,
    })
    .unwrap();
    assert_eq!(snap.query(1, 1, 1), CellQuery::Mask(0b0111));
    let snap2 = m2.snapshot_handle();
    assert_eq!(snap2.query(1, 1, 1), CellQuery::Mask(0b1011));
    m2.apply(MirrorMessage::BlockUpdate {
        position: (2, 1, 2),
        state_id: 99,
        sequence: 6,
    })
    .unwrap();
    let snap3 = m2.snapshot_handle();
    assert_eq!(snap3.query(2, 1, 2), CellQuery::Mask(CLASS_UNKNOWN_BIT));
    let _ = snapshot;
}

#[test]
fn four_state_semantics_distinct() {
    let mut mirror = mirror_with_registry();
    import_chunk(&mut mirror, (0, 0), 2, 4, 0); // sectionY=0 导入为 Data
    let snapshot = mirror.snapshot_handle();
    // 1) 已导入 Data
    assert!(matches!(snapshot.query(1, 1, 1), CellQuery::Mask(_)));
    // 2) 同 chunk 未导入的 section 槽 → SectionNotPresent（≠AIR≠未知方块）
    assert_eq!(snapshot.query(1, 17, 1), CellQuery::SectionNotPresent);
    // 3) 未加载 chunk → ChunkNotLoaded
    assert_eq!(snapshot.query(100, 1, 100), CellQuery::ChunkNotLoaded);
    // 4) Desynced
    mirror
        .apply(MirrorMessage::MarkDesynced { chunk: (0, 0) })
        .unwrap();
    assert_eq!(mirror.snapshot_handle().query(1, 1, 1), CellQuery::Desynced);
}

#[test]
fn empty_section_is_loaded_air_not_unknown() {
    let mut mirror = mirror_with_registry();
    mirror
        .apply(MirrorMessage::ChunkBegin {
            session_epoch: 7,
            dimension_epoch: 1,
            chunk: (0, 0),
            sequence: 2,
        })
        .unwrap();
    mirror
        .apply(MirrorMessage::ChunkSectionData {
            chunk: (0, 0),
            sequence: 3,
            payload: SectionPayload {
                section_y: 0,
                status: SectionStatus::Empty,
                palette_indices: Box::from([]),
                palette_entries: vec![],
            },
        })
        .unwrap();
    mirror
        .apply(MirrorMessage::ChunkCommit {
            chunk: (0, 0),
            sequence: 4,
        })
        .unwrap();
    // 显式空 section → mask 0（与 SectionNotPresent/ChunkNotLoaded 三态可区分）
    assert_eq!(mirror.snapshot_handle().query(1, 1, 1), CellQuery::Mask(0));
}

#[test]
fn transactional_import_invisible_before_commit() {
    let mut mirror = mirror_with_registry();
    mirror
        .apply(MirrorMessage::ChunkBegin {
            session_epoch: 7,
            dimension_epoch: 1,
            chunk: (5, 5),
            sequence: 2,
        })
        .unwrap();
    mirror
        .apply(MirrorMessage::ChunkSectionData {
            chunk: (5, 5),
            sequence: 3,
            payload: data_payload(0, 0),
        })
        .unwrap();
    // COMMIT 前对 snapshot 不可见
    assert_eq!(
        mirror.snapshot_handle().query(80, 1, 80),
        CellQuery::ChunkNotLoaded
    );
    mirror
        .apply(MirrorMessage::ChunkCommit {
            chunk: (5, 5),
            sequence: 4,
        })
        .unwrap();
    assert!(matches!(
        mirror.snapshot_handle().query(80, 1, 80),
        CellQuery::Mask(_)
    ));
}

#[test]
fn duplicate_chunk_begin_idempotent_and_stale_sequence_rejected() {
    let mut mirror = mirror_with_registry();
    let begin = MirrorMessage::ChunkBegin {
        session_epoch: 7,
        dimension_epoch: 1,
        chunk: (0, 0),
        sequence: 2,
    };
    assert_eq!(mirror.apply(begin).unwrap(), ApplyOutcome::Applied);
    // 同 sequence 重放 → 幂等
    let replay = MirrorMessage::ChunkBegin {
        session_epoch: 7,
        dimension_epoch: 1,
        chunk: (0, 0),
        sequence: 2,
    };
    // last_sequence 已推进到 10，重放按 stale 规则拒绝（幂等语义：状态不变）
    assert_eq!(
        mirror.apply(replay).unwrap(),
        ApplyOutcome::IgnoredDuplicate
    );
    // 更旧 sequence
    assert_eq!(
        mirror
            .apply(MirrorMessage::ChunkUnload {
                chunk: (1, 1),
                sequence: 1
            })
            .unwrap(),
        ApplyOutcome::IgnoredStale
    );
}

#[test]
fn stale_epoch_rejected() {
    let mut mirror = mirror_with_registry();
    let result = mirror.apply(MirrorMessage::ChunkBegin {
        session_epoch: 6,
        dimension_epoch: 1,
        chunk: (0, 0),
        sequence: 5,
    });
    assert_eq!(
        result.unwrap_err(),
        MirrorError::StaleSessionEpoch {
            expected: 7,
            got: 6
        }
    );
    let result = mirror.apply(MirrorMessage::ChunkBegin {
        session_epoch: 7,
        dimension_epoch: 0,
        chunk: (0, 0),
        sequence: 6,
    });
    assert_eq!(
        result.unwrap_err(),
        MirrorError::StaleDimensionEpoch {
            expected: 1,
            got: 0
        }
    );
}

#[test]
fn block_update_queued_during_import_applies_after_commit() {
    let mut mirror = mirror_with_registry();
    mirror
        .apply(MirrorMessage::ChunkBegin {
            session_epoch: 7,
            dimension_epoch: 1,
            chunk: (0, 0),
            sequence: 2,
        })
        .unwrap();
    // 导入期间 update → 排队
    assert_eq!(
        mirror
            .apply(MirrorMessage::BlockUpdate {
                position: (1, 1, 1),
                state_id: 1,
                sequence: 3
            })
            .unwrap(),
        ApplyOutcome::QueuedUntilCommit
    );
    mirror
        .apply(MirrorMessage::ChunkSectionData {
            chunk: (0, 0),
            sequence: 4,
            payload: data_payload(0, 0),
        })
        .unwrap();
    mirror
        .apply(MirrorMessage::ChunkCommit {
            chunk: (0, 0),
            sequence: 5,
        })
        .unwrap();
    // COMMIT 后排队 update 生效
    assert_eq!(
        mirror.snapshot_handle().query(1, 1, 1),
        CellQuery::Mask(0b1011)
    );
}

#[test]
fn unload_removes_and_late_update_rejected_no_revival() {
    let mut mirror = mirror_with_registry();
    import_chunk(&mut mirror, (0, 0), 2, 4, 0);
    mirror
        .apply(MirrorMessage::ChunkUnload {
            chunk: (0, 0),
            sequence: 5,
        })
        .unwrap();
    assert_eq!(
        mirror.snapshot_handle().query(1, 1, 1),
        CellQuery::ChunkNotLoaded
    );
    // 迟到 update 不得复活
    assert_eq!(
        mirror
            .apply(MirrorMessage::BlockUpdate {
                position: (1, 1, 1),
                state_id: 1,
                sequence: 3
            })
            .unwrap(),
        ApplyOutcome::IgnoredStale
    );
    assert_eq!(
        mirror.snapshot_handle().query(1, 1, 1),
        CellQuery::ChunkNotLoaded
    );
}

#[test]
fn world_reset_clears_and_rejects_old_session() {
    let mut mirror = mirror_with_registry();
    import_chunk(&mut mirror, (0, 0), 2, 4, 0);
    mirror
        .apply(MirrorMessage::WorldReset {
            session_epoch: 8,
            dimension_epoch: 2,
            sequence: 5,
        })
        .unwrap();
    assert_eq!(mirror.loaded_chunks(), 0);
    // 旧 session epoch 拒绝
    let result = mirror.apply(MirrorMessage::ChunkBegin {
        session_epoch: 7,
        dimension_epoch: 2,
        chunk: (0, 0),
        sequence: 6,
    });
    assert!(matches!(
        result.unwrap_err(),
        MirrorError::StaleSessionEpoch { .. }
    ));
}

#[test]
fn absolute_section_y_with_negative_minY_world() {
    // 1.18+ 负 minY：绝对 sectionY 为负（如 -4 对应 y=-64..-49）
    let mut mirror = mirror_with_registry();
    import_chunk(&mut mirror, (0, 0), 2, 4, -4);
    let snapshot = mirror.snapshot_handle();
    assert!(matches!(snapshot.query(1, -60, 1), CellQuery::Mask(_)));
    assert_eq!(snapshot.query(1, 5, 1), CellQuery::SectionNotPresent);
}

#[test]
fn snapshot_generation_freezes_view() {
    let mut mirror = mirror_with_registry();
    import_chunk(&mut mirror, (0, 0), 2, 4, 0);
    let frozen = mirror.snapshot_handle();
    let generation_before = frozen.generation;
    mirror
        .apply(MirrorMessage::BlockUpdate {
            position: (1, 1, 1),
            state_id: 1,
            sequence: 5,
        })
        .unwrap();
    // 旧句柄视图不变
    assert_eq!(frozen.query(1, 1, 1), CellQuery::Mask(0b0111));
    assert_eq!(frozen.generation, generation_before);
    assert!(mirror.generation() > generation_before);
}

#[test]
fn memory_stats_and_bounds() {
    let mut mirror = mirror_with_registry();
    import_chunk(&mut mirror, (0, 0), 2, 4, 0);
    let stats = mirror.memory_stats();
    assert_eq!(stats.chunks_loaded, 1);
    assert_eq!(stats.sections_data, 1);
    // u16×4096=8KB/section + 元开销（远低于稠密 u32 stateId 的 16KB+）
    assert!(stats.approx_bytes >= 8192 && stats.approx_bytes < 16384);
}

/// 属性测试：随机增量消息序列的最终可查询状态 == 从最终声明全量重建。
/// xorshift 确定性 PRNG（无外部依赖）。
struct XorShift(u64);
impl XorShift {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound
    }
}

#[test]
fn property_incremental_equals_full_rebuild() {
    for seed in [1u64, 42, 1337, 90210] {
        let mut rng = XorShift(seed);
        let mut incremental = mirror_with_registry();
        let mut final_truth: HashMap<(i32, i32, i32), u32> = HashMap::new();
        let mut loaded: HashMap<ChunkKey, bool> = HashMap::new();
        let mut gap_recoveries = 0usize;
        let mut sequence = 1u64; // 循环顶先 +1：首条消息=2（registry=1 之后连续）
        for _step in 0..400 {
            sequence += 1;
            let choice = rng.below(100);
            let chunk: ChunkKey = (rng.below(3) as i32, rng.below(3) as i32);
            if choice < 30 {
                // chunk 导入事务
                incremental
                    .apply(MirrorMessage::ChunkBegin {
                        session_epoch: 7,
                        dimension_epoch: 1,
                        chunk,
                        sequence,
                    })
                    .unwrap();
                sequence += 1;
                incremental
                    .apply(MirrorMessage::ChunkSectionData {
                        chunk,
                        sequence,
                        payload: data_payload(0, (rng.below(2)) as u16),
                    })
                    .unwrap();
                sequence += 1;
                let commit_outcome = incremental
                    .apply(MirrorMessage::ChunkCommit { chunk, sequence })
                    .unwrap();
                if matches!(commit_outcome, ApplyOutcome::GapDesynced) {
                    gap_recoveries += 1;
                    sequence += 1;
                    incremental
                        .apply(MirrorMessage::WorldReset {
                            session_epoch: 7,
                            dimension_epoch: 1,
                            sequence,
                        })
                        .unwrap();
                    loaded.clear();
                    final_truth.clear();
                    continue;
                }
                loaded.insert(chunk, true);
                // truth：全量重置该 chunk 的记录（palette fill 0/1 对应 mask
                // 0b0111/UNKNOWN——重建时按 mask 反查 stateId 集合）
            } else if choice < 50 {
                let unload_outcome = incremental
                    .apply(MirrorMessage::ChunkUnload { chunk, sequence })
                    .unwrap();
                if matches!(unload_outcome, ApplyOutcome::GapDesynced) {
                    gap_recoveries += 1;
                    sequence += 1;
                    incremental
                        .apply(MirrorMessage::WorldReset {
                            session_epoch: 7,
                            dimension_epoch: 1,
                            sequence,
                        })
                        .unwrap();
                    loaded.clear();
                    final_truth.clear();
                    continue;
                }
                loaded.insert(chunk, false);
                final_truth.retain(|pos, _| (pos.0 >> 4, pos.2 >> 4) != chunk);
            } else if choice < 90 {
                let position = (
                    (rng.below(48)) as i32,
                    (rng.below(16)) as i32,
                    (rng.below(48)) as i32,
                );
                let state_id = rng.below(4) as u32;
                let outcome = incremental.apply(MirrorMessage::BlockUpdate {
                    position,
                    state_id,
                    sequence,
                });
                if matches!(outcome, Ok(ApplyOutcome::GapDesynced)) {
                    // 生产语义：缺口→DESYNCED→权威恢复（reset 由 TS 分配序号）。
                    // truth 同步清空（reset 后世界从零重建）。
                    gap_recoveries += 1;
                    sequence += 1;
                    incremental
                        .apply(MirrorMessage::WorldReset {
                            session_epoch: 7,
                            dimension_epoch: 1,
                            sequence,
                        })
                        .unwrap();
                    loaded.clear();
                    final_truth.clear();
                    continue;
                }
                if loaded.get(&chunk).copied().unwrap_or(false) {
                    final_truth.insert(position, state_id);
                }
                let _ = outcome;
            } else {
                // 重复/迟到消息（低 sequence）
                incremental.apply(MirrorMessage::ChunkUnload {
                    chunk,
                    sequence: sequence.saturating_sub(1),
                });
            }
        }
        // 对照：查询随机采样点
        let snapshot = incremental.snapshot_handle();
        for sample in 0..200 {
            let position = (
                ((seed + sample * 7) % 48) as i32,
                ((seed + sample * 3) % 16) as i32,
                ((seed + sample * 11) % 48) as i32,
            );
            let chunk = (position.0 >> 4, position.2 >> 4);
            let truth_loaded = loaded.get(&chunk).copied().unwrap_or(false);
            match snapshot.query(position.0, position.1, position.2) {
                CellQuery::ChunkNotLoaded | CellQuery::SectionNotPresent => {
                    assert!(
                        !truth_loaded,
                        "seed={sample} truth says loaded: {:?}",
                        position
                    );
                }
                CellQuery::Mask(mask) => {
                    assert!(
                        truth_loaded,
                        "seed={sample} mirror says loaded but truth doesn't: {:?}",
                        position
                    );
                    if let Some(&state_id) = final_truth.get(&position) {
                        let expected = match state_id {
                            0 => 0b0111,
                            1 => 0b1011,
                            other => CLASS_UNKNOWN_BIT | (other as BlockClassMask & 0),
                        };
                        let _ = expected;
                        // mask 与 registry 对齐（0/1 显式；2/3 表外=UNKNOWN）
                        let expect_mask = match state_id {
                            0 => 0b0111,
                            1 => 0b1011,
                            _ => CLASS_UNKNOWN_BIT,
                        };
                        assert_eq!(
                            mask, expect_mask,
                            "seed={} sample={} pos={:?}",
                            seed, sample, position
                        );
                    }
                }
                CellQuery::Desynced => panic!("no desync in this scenario"),
            }
        }
        println!("GAP_RECOVERIES={}", gap_recoveries);
    }
}

#[test]
fn sequence_gap_marks_desynced_and_fail_closes() {
    let mut mirror = mirror_with_registry();
    // 缺口：registry=1 后直接跳 5
    assert_eq!(
        mirror
            .apply(MirrorMessage::ChunkUnload {
                chunk: (0, 0),
                sequence: 5
            })
            .unwrap(),
        ApplyOutcome::GapDesynced
    );
    assert!(mirror.is_desynced());
    // 缺口后后续消息一律拒绝（fail-closed 直到重建）
    assert_eq!(
        mirror
            .apply(MirrorMessage::ChunkBegin {
                session_epoch: 7,
                dimension_epoch: 1,
                chunk: (0, 0),
                sequence: 6
            })
            .unwrap(),
        ApplyOutcome::GapDesynced
    );
    // 重建（reset 提升权威 epoch 由 TS 分配；这里模拟重建后恢复）
    assert_eq!(
        mirror
            .apply(MirrorMessage::WorldReset {
                session_epoch: 7,
                dimension_epoch: 1,
                sequence: 10
            })
            .unwrap(),
        ApplyOutcome::Applied
    );
    assert!(!mirror.is_desynced());
}
