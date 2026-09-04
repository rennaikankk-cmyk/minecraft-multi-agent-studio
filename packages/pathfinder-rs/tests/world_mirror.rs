//! P5-C/D2b WorldMirror 单元+属性测试。
//! 完成门对照：随机增量序列结果==最终状态全量重建；旧 epoch/重复消息/
//! unload 后迟到更新全部正确；UNKNOWN/AIR/INCOMPLETE 四态语义有测试。
//! D2b 新增：registry 先行屏障、Empty fillStateId 分类、batch source
//! 范围/合并/导入期重放顺序、权威 Reset（epoch 严格前进+重握手）、
//! 语义拒绝消费传输槽。

use pathfinder_rs::world_mirror::*;
use pathfinder_rs::world_mirror_protocol::*;
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// 迁移 helper（D2b：所有旧式构造经此集中——禁止散落重复样板）。
// ---------------------------------------------------------------------------

const SESSION: u64 = 7;
const DIMENSION: u64 = 1;

struct Driver {
    session: MirrorSession,
    sequence: u64,
    session_epoch: u64,
    dimension_epoch: u64,
    /// 最近一次 send 的 (序号, 消息)——精确重放测试用。
    last_sent: (u64, MirrorMessage),
}

impl Driver {
    fn new() -> Self {
        Driver {
            session: MirrorSession::new(SESSION, DIMENSION),
            sequence: 0,
            session_epoch: SESSION,
            dimension_epoch: DIMENSION,
            last_sent: (0, MirrorMessage::ChunkBegin { chunk: (0, 0) }),
        }
    }

    fn send(&mut self, message: MirrorMessage) -> MirrorAck {
        self.sequence += 1;
        let ack = self.submit(self.sequence, message.clone());
        self.last_sent = (self.sequence, message);
        ack
    }

    /// 显式序号提交（stale/duplicate 测试用）。
    fn submit(&mut self, sequence: u64, message: MirrorMessage) -> MirrorAck {
        self.session.submit_envelope(MirrorEnvelope {
            protocol_version: MIRROR_PROTOCOL_VERSION,
            session_epoch: self.session_epoch,
            dimension_epoch: self.dimension_epoch,
            transport_sequence: sequence,
            message,
        })
    }

    /// 权威 Reset：epoch 严格前进 + 序号重基。
    fn reset(&mut self) -> MirrorAck {
        self.session_epoch += 1;
        self.sequence = 0;
        self.session.submit_control(&MirrorControl::WorldReset {
            new_session_epoch: self.session_epoch,
            new_dimension_epoch: self.dimension_epoch,
            reason: WorldResetReason::DesyncRecovery,
            resync_token: 0,
        })
    }

    fn reset_dimension(&mut self) -> MirrorAck {
        self.dimension_epoch += 1;
        self.sequence = 0;
        self.session.submit_control(&MirrorControl::WorldReset {
            new_session_epoch: self.session_epoch,
            new_dimension_epoch: self.dimension_epoch,
            reason: WorldResetReason::DimensionChange,
            resync_token: 0,
        })
    }
}

/// 已就绪驱动器：registry 握手完成（revision=1，两态表）。
/// registry[0]=AIR|PASSABLE 假设由 TS 握手决定；registry[1]=多类别方块。
fn driver_with_registry() -> Driver {
    let mut driver = Driver::new();
    let ack = driver.send(registry_message(1, &[0b0111, 0b1011]));
    assert_eq!(ack.status, AckStatus::RegistryReady);
    assert_eq!(ack.registry_revision, Some(1));
    driver
}

fn registry_message(revision: u64, masks: &[BlockClassMask]) -> MirrorMessage {
    MirrorMessage::RegistryTable {
        revision,
        masks: masks.to_vec(),
        minecraft_version: None,
        server_profile_id: None,
    }
}

fn data_payload(section_y: i32, fill: u16) -> SectionPayload {
    SectionPayload::Data {
        section_y,
        palette_indices: vec![fill; 4096].into_boxed_slice(),
        palette_entries: vec![0b0111, CLASS_UNKNOWN_BIT],
    }
}

fn update_batch(
    source_first: u64,
    source_last: u64,
    entries: &[(i32, i32, i32, u32)],
) -> MirrorMessage {
    MirrorMessage::BlockUpdateBatch {
        source_first_sequence: source_first,
        source_last_sequence: source_last,
        source_event_count: entries.len() as u64,
        coalesced_event_count: None,
        updates: entries
            .iter()
            .map(|&(x, y, z, state_id)| BlockUpdateEntry {
                position: (x, y, z),
                state_id,
            })
            .collect(),
    }
}

/// 完整导入事务（begin → data(fill) → commit），全 Applied 断言。
fn import_chunk(driver: &mut Driver, chunk: ChunkKey, section_y: i32) {
    assert_eq!(
        driver.send(MirrorMessage::ChunkBegin { chunk }).status,
        AckStatus::Applied
    );
    assert_eq!(
        driver
            .send(MirrorMessage::SectionData {
                chunk,
                payload: data_payload(section_y, 0)
            })
            .status,
        AckStatus::Applied
    );
    assert_eq!(
        driver.send(MirrorMessage::ChunkCommit { chunk }).status,
        AckStatus::Applied
    );
}

// ---------------------------------------------------------------------------
// P5-C 语义回归（经 helper 迁移）。
// ---------------------------------------------------------------------------

#[test]
fn registry_handshake_and_unknown_state_id() {
    let mut driver = driver_with_registry();
    import_chunk(&mut driver, (0, 0), 0);
    let snapshot = driver.session.mirror().snapshot_handle();
    // stateId 在表内 → 查到 mask；表外（如 99）→ UNKNOWN 位（非 AIR）。
    assert_eq!(snapshot.query(1, 1, 1), CellQuery::Mask(0b0111));
    driver.send(update_batch(100, 100, &[(1, 1, 1, 1)]));
    let snapshot = driver.session.mirror().snapshot_handle();
    assert_eq!(snapshot.query(1, 1, 1), CellQuery::Mask(0b1011));
    driver.send(update_batch(101, 101, &[(2, 1, 2, 99)]));
    let snapshot = driver.session.mirror().snapshot_handle();
    assert_eq!(snapshot.query(2, 1, 2), CellQuery::Mask(CLASS_UNKNOWN_BIT));
}

#[test]
fn four_state_semantics_distinct() {
    let mut driver = driver_with_registry();
    import_chunk(&mut driver, (0, 0), 0); // sectionY=0 导入为 Data
    let snapshot = driver.session.mirror().snapshot_handle();
    // 1) 已导入 Data
    assert!(matches!(snapshot.query(1, 1, 1), CellQuery::Mask(_)));
    // 2) 同 chunk 未导入的 section 槽 → SectionNotPresent（≠AIR≠未知方块）
    assert_eq!(snapshot.query(1, 17, 1), CellQuery::SectionNotPresent);
    // 3) 未加载 chunk → ChunkNotLoaded
    assert_eq!(snapshot.query(100, 1, 100), CellQuery::ChunkNotLoaded);
    // 4) Desynced（内部诊断入口）
    driver
        .session
        .mirror_mut()
        .mark_chunk_desynced((0, 0))
        .unwrap();
    assert_eq!(
        driver.session.mirror().snapshot_handle().query(1, 1, 1),
        CellQuery::Desynced
    );
}

#[test]
fn transactional_import_invisible_before_commit() {
    let mut driver = driver_with_registry();
    driver.send(MirrorMessage::ChunkBegin { chunk: (5, 5) });
    driver.send(MirrorMessage::SectionData {
        chunk: (5, 5),
        payload: data_payload(0, 0),
    });
    // COMMIT 前对 snapshot 不可见
    assert_eq!(
        driver.session.mirror().snapshot_handle().query(80, 1, 80),
        CellQuery::ChunkNotLoaded
    );
    driver.send(MirrorMessage::ChunkCommit { chunk: (5, 5) });
    assert!(matches!(
        driver.session.mirror().snapshot_handle().query(80, 1, 80),
        CellQuery::Mask(_)
    ));
}

#[test]
fn duplicate_and_stale_transport_sequences() {
    let mut driver = driver_with_registry();
    let ack = driver.send(MirrorMessage::ChunkBegin { chunk: (0, 0) });
    assert_eq!(ack.status, AckStatus::Applied);
    // 同序号同内容重放 → IgnoredDuplicate（不 desync）
    let replay = driver.submit(1, registry_message(1, &[0b0111, 0b1011]));
    // 注意：seq=1 是 registry——ChunkBegin 是 seq=2。用正确内容重放 seq=2：
    let _ = replay;
    let replay = driver.submit(2, MirrorMessage::ChunkBegin { chunk: (0, 0) });
    assert_eq!(replay.status, AckStatus::IgnoredDuplicate);
    assert!(!driver.session.health().desynced);
    // 同序号不同内容 → ProtocolConflict + desynced
    let conflict = driver.submit(2, MirrorMessage::ChunkBegin { chunk: (9, 9) });
    assert_eq!(conflict.status, AckStatus::ProtocolConflict);
    assert!(driver.session.health().desynced);
}

#[test]
fn stale_epoch_rejected() {
    let mut driver = driver_with_registry();
    let mut envelope = MirrorEnvelope {
        protocol_version: MIRROR_PROTOCOL_VERSION,
        session_epoch: 6,
        dimension_epoch: 1,
        transport_sequence: 2,
        message: MirrorMessage::ChunkBegin { chunk: (0, 0) },
    };
    assert_eq!(
        driver.session.submit_envelope(envelope.clone()).status,
        AckStatus::WrongEpoch
    );
    envelope.session_epoch = 7;
    envelope.dimension_epoch = 0;
    assert_eq!(
        driver.session.submit_envelope(envelope).status,
        AckStatus::WrongEpoch
    );
}

#[test]
fn block_update_queued_during_import_applies_after_commit() {
    let mut driver = driver_with_registry();
    driver.send(MirrorMessage::ChunkBegin { chunk: (0, 0) });
    // 导入期间 batch → 排队（ack=QueuedUntilCommit，传输槽已消费）
    let ack = driver.send(update_batch(100, 100, &[(1, 1, 1, 1)]));
    assert_eq!(ack.status, AckStatus::QueuedUntilCommit);
    driver.send(MirrorMessage::SectionData {
        chunk: (0, 0),
        payload: data_payload(0, 0),
    });
    driver.send(MirrorMessage::ChunkCommit { chunk: (0, 0) });
    // COMMIT 后排队 update 生效
    assert_eq!(
        driver.session.mirror().snapshot_handle().query(1, 1, 1),
        CellQuery::Mask(0b1011)
    );
}

#[test]
fn unload_removes_and_late_update_rejected_no_revival() {
    let mut driver = driver_with_registry();
    import_chunk(&mut driver, (0, 0), 0);
    driver.send(MirrorMessage::ChunkUnload { chunk: (0, 0) });
    assert_eq!(
        driver.session.mirror().snapshot_handle().query(1, 1, 1),
        CellQuery::ChunkNotLoaded
    );
    // 迟到 update（新传输序号、旧 source）：不复活 chunk，计入 skipped
    let ack = driver.send(update_batch(3, 3, &[(1, 1, 1, 1)]));
    assert_eq!(ack.status, AckStatus::Applied);
    assert_eq!(ack.skipped_updates, Some(1));
    assert_eq!(
        driver.session.mirror().snapshot_handle().query(1, 1, 1),
        CellQuery::ChunkNotLoaded
    );
    // 迟到 COMMIT 不复活
    let ack = driver.send(MirrorMessage::ChunkCommit { chunk: (0, 0) });
    assert_eq!(ack.status, AckStatus::SemanticRejected);
    assert_eq!(ack.reason, Some(AckReason::NoOpenImport));
    assert_eq!(
        driver.session.mirror().snapshot_handle().query(1, 1, 1),
        CellQuery::ChunkNotLoaded
    );
}

#[test]
fn absolute_section_y_with_negative_minY_world() {
    // 1.18+ 负 minY：绝对 sectionY 为负（如 -4 对应 y=-64..-49）
    let mut driver = driver_with_registry();
    import_chunk(&mut driver, (0, 0), -4);
    let snapshot = driver.session.mirror().snapshot_handle();
    assert!(matches!(snapshot.query(1, -60, 1), CellQuery::Mask(_)));
    assert_eq!(snapshot.query(1, 5, 1), CellQuery::SectionNotPresent);
}

#[test]
fn snapshot_generation_freezes_view() {
    let mut driver = driver_with_registry();
    import_chunk(&mut driver, (0, 0), 0);
    let frozen = driver.session.mirror().snapshot_handle();
    let generation_before = frozen.generation;
    driver.send(update_batch(100, 100, &[(1, 1, 1, 1)]));
    // 旧句柄视图不变
    assert_eq!(frozen.query(1, 1, 1), CellQuery::Mask(0b0111));
    assert_eq!(frozen.generation, generation_before);
    assert!(driver.session.mirror().generation() > generation_before);
}

#[test]
fn memory_stats_and_bounds() {
    let mut driver = driver_with_registry();
    import_chunk(&mut driver, (0, 0), 0);
    let stats = driver.session.mirror().memory_stats();
    assert_eq!(stats.chunks_loaded, 1);
    assert_eq!(stats.sections_data, 1);
    // u16×4096=8KB/section + 元开销（远低于稠密 u32 stateId 的 16KB+）
    assert!(stats.approx_bytes >= 8192 && stats.approx_bytes < 16384);
}

// ---------------------------------------------------------------------------
// D2b 新语义。
// ---------------------------------------------------------------------------

#[test]
fn registry_must_precede_chunk_traffic() {
    // RegistryReady 前收到 chunk/update = 协议顺序错误（数据已丢）：
    // Desynced + ResetRequired，不能当普通 SemanticRejected 继续。
    let mut driver = Driver::new();
    let ack = driver.send(MirrorMessage::ChunkBegin { chunk: (0, 0) });
    assert_eq!(ack.status, AckStatus::ResetRequired);
    assert_eq!(ack.reason, Some(AckReason::RegistryNotReady));
    assert!(driver.session.health().desynced);
    // desynced 后一切数据消息 ResetRequired（fail-close 直到权威 Reset）
    let ack = driver.send(registry_message(1, &[0b0111]));
    assert_eq!(ack.status, AckStatus::ResetRequired);
    // 权威 Reset → 重新握手 → 正常
    assert_eq!(driver.reset().status, AckStatus::ResetApplied);
    assert!(!driver.session.health().desynced);
    assert_eq!(
        driver.send(registry_message(1, &[0b0111, 0b1011])).status,
        AckStatus::RegistryReady
    );
    import_chunk(&mut driver, (0, 0), 0);
    assert!(matches!(
        driver.session.mirror().snapshot_handle().query(1, 1, 1),
        CellQuery::Mask(_)
    ));
}

#[test]
fn registry_rehandshake_idempotent_or_reset() {
    let mut driver = driver_with_registry();
    // 同 revision 同表重发 → 幂等 RegistryReady
    let ack = driver.send(registry_message(1, &[0b0111, 0b1011]));
    assert_eq!(ack.status, AckStatus::RegistryReady);
    // 同 revision 不同表（digest mismatch）→ ResetRequired + desynced
    let ack = driver.send(registry_message(1, &[0b0111, 0b1111]));
    assert_eq!(ack.status, AckStatus::ResetRequired);
    assert_eq!(ack.reason, Some(AckReason::RegistryMismatch));
    assert!(driver.session.health().desynced);
    // 恢复：reset → 新 revision 表
    driver.reset();
    let ack = driver.send(registry_message(2, &[0b0111, 0b1111]));
    assert_eq!(ack.status, AckStatus::RegistryReady);
    assert_eq!(ack.registry_revision, Some(2));
    // 换 revision 不经 reset（已 READY 时直接发新 revision）→ 同样拒绝
    let ack = driver.send(registry_message(3, &[0b0111, 0b1111]));
    assert_eq!(ack.status, AckStatus::ResetRequired);
}

#[test]
fn empty_fill_state_id_classified_through_registry() {
    let mut driver = driver_with_registry();
    // Empty fill=0 → registry[0]=0b0111（经表分类，非硬编码 mask 0）
    driver.send(MirrorMessage::ChunkBegin { chunk: (0, 0) });
    driver.send(MirrorMessage::SectionData {
        chunk: (0, 0),
        payload: SectionPayload::Empty {
            section_y: 0,
            fill_state_id: 0,
        },
    });
    driver.send(MirrorMessage::ChunkCommit { chunk: (0, 0) });
    assert_eq!(
        driver.session.mirror().snapshot_handle().query(1, 1, 1),
        CellQuery::Mask(0b0111)
    );
    // Empty fill=1 → registry[1]=0b1011
    driver.send(MirrorMessage::ChunkBegin { chunk: (1, 0) });
    driver.send(MirrorMessage::SectionData {
        chunk: (1, 0),
        payload: SectionPayload::Empty {
            section_y: 0,
            fill_state_id: 1,
        },
    });
    driver.send(MirrorMessage::ChunkCommit { chunk: (1, 0) });
    assert_eq!(
        driver.session.mirror().snapshot_handle().query(17, 1, 1),
        CellQuery::Mask(0b1011)
    );
    // Empty fill=表外 → UNKNOWN 位（绝不硬编码"0=空气"）
    driver.send(MirrorMessage::ChunkBegin { chunk: (2, 0) });
    driver.send(MirrorMessage::SectionData {
        chunk: (2, 0),
        payload: SectionPayload::Empty {
            section_y: 0,
            fill_state_id: 9999,
        },
    });
    driver.send(MirrorMessage::ChunkCommit { chunk: (2, 0) });
    assert_eq!(
        driver.session.mirror().snapshot_handle().query(33, 1, 1),
        CellQuery::Mask(CLASS_UNKNOWN_BIT)
    );
}

#[test]
fn not_present_is_not_air() {
    let mut driver = driver_with_registry();
    driver.send(MirrorMessage::ChunkBegin { chunk: (0, 0) });
    driver.send(MirrorMessage::SectionData {
        chunk: (0, 0),
        payload: SectionPayload::NotPresent { section_y: 0 },
    });
    driver.send(MirrorMessage::ChunkCommit { chunk: (0, 0) });
    // NotPresent 槽缺席 ≠ AIR（mask）≠ UNKNOWN ≠ 未加载 chunk：三态可区分
    assert_eq!(
        driver.session.mirror().snapshot_handle().query(1, 1, 1),
        CellQuery::SectionNotPresent
    );
}

#[test]
fn batch_multi_position_and_coalesced_final_value() {
    let mut driver = driver_with_registry();
    import_chunk(&mut driver, (0, 0), 0);
    // 原事件 101、102、103 更新同一坐标，合并后只发 103 的最终 stateId=1；
    // 批内另一坐标独立。source 序号不连续/有空洞不影响 transport 连续性。
    let ack = driver.send(MirrorMessage::BlockUpdateBatch {
        source_first_sequence: 101,
        source_last_sequence: 103,
        source_event_count: 4,
        coalesced_event_count: Some(2),
        updates: vec![
            BlockUpdateEntry {
                position: (1, 1, 1),
                state_id: 1,
            },
            BlockUpdateEntry {
                position: (2, 1, 2),
                state_id: 1,
            },
        ],
    });
    assert_eq!(ack.status, AckStatus::Applied);
    let snapshot = driver.session.mirror().snapshot_handle();
    assert_eq!(snapshot.query(1, 1, 1), CellQuery::Mask(0b1011));
    assert_eq!(snapshot.query(2, 1, 2), CellQuery::Mask(0b1011));
    // transport 序号仍连续（下一条 seq=next Applied，无假缺口）
    let ack = driver.send(MirrorMessage::ChunkUnload { chunk: (50, 50) });
    assert_eq!(ack.status, AckStatus::Applied);
}

#[test]
fn import_replay_uses_source_order_not_arrival_order() {
    let mut driver = driver_with_registry();
    driver.send(MirrorMessage::ChunkBegin { chunk: (0, 0) });
    driver.send(MirrorMessage::SectionData {
        chunk: (0, 0),
        payload: data_payload(0, 0),
    });
    // 先到 source=300 的最终值 7，后到 source=200 的旧值 5——COMMIT 后
    // 按 source 顺序重放 → 最终 = 最高 source 的观测（7），与到达顺序无关。
    driver.send(update_batch(300, 300, &[(1, 1, 1, 1)])); // stateId 1 → mask 0b1011
    driver.send(update_batch(200, 200, &[(1, 1, 1, 0)])); // stateId 0 → mask 0b0111
    driver.send(MirrorMessage::ChunkCommit { chunk: (0, 0) });
    assert_eq!(
        driver.session.mirror().snapshot_handle().query(1, 1, 1),
        CellQuery::Mask(0b1011)
    );
}

#[test]
fn unload_clears_pending_import_and_queued_updates() {
    let mut driver = driver_with_registry();
    driver.send(MirrorMessage::ChunkBegin { chunk: (0, 0) });
    driver.send(MirrorMessage::SectionData {
        chunk: (0, 0),
        payload: data_payload(0, 0),
    });
    driver.send(update_batch(100, 100, &[(1, 1, 1, 1)]));
    let health = driver.session.health();
    assert_eq!(health.queued_updates, 1);
    assert_eq!(health.pending_imports, 1);
    driver.send(MirrorMessage::ChunkUnload { chunk: (0, 0) });
    let health = driver.session.health();
    assert_eq!(health.queued_updates, 0);
    assert_eq!(health.pending_imports, 0);
    // 迟到 COMMIT 不复活
    let ack = driver.send(MirrorMessage::ChunkCommit { chunk: (0, 0) });
    assert_eq!(ack.status, AckStatus::SemanticRejected);
}

#[test]
fn reset_requires_strictly_higher_epoch() {
    let mut driver = driver_with_registry();
    // 同 epoch 迟到 Reset → 拒绝
    let ack = driver.session.submit_control(&MirrorControl::WorldReset {
        new_session_epoch: SESSION,
        new_dimension_epoch: DIMENSION,
        reason: WorldResetReason::SessionRestart,
        resync_token: 0,
    });
    assert_eq!(ack.status, AckStatus::WrongEpoch);
    assert_eq!(ack.reason, Some(AckReason::EpochNotAdvanced));
    // 更旧 epoch → 拒绝
    let ack = driver.session.submit_control(&MirrorControl::WorldReset {
        new_session_epoch: SESSION - 1,
        new_dimension_epoch: DIMENSION,
        reason: WorldResetReason::SessionRestart,
        resync_token: 0,
    });
    assert_eq!(ack.status, AckStatus::WrongEpoch);
    // 仅 dimension 前进 → 接受
    let mut driver2 = driver_with_registry();
    driver2.dimension_epoch += 1;
    let ack = driver2.session.submit_control(&MirrorControl::WorldReset {
        new_session_epoch: SESSION,
        new_dimension_epoch: DIMENSION + 1,
        reason: WorldResetReason::DimensionChange,
        resync_token: 0,
    });
    assert_eq!(ack.status, AckStatus::ResetApplied);
    // epoch 倒退组合（session 前进+dimension 倒退）→ 拒绝
    let ack = driver2.session.submit_control(&MirrorControl::WorldReset {
        new_session_epoch: SESSION + 5,
        new_dimension_epoch: DIMENSION,
        reason: WorldResetReason::SessionRestart,
        resync_token: 0,
    });
    assert_eq!(ack.status, AckStatus::WrongEpoch);
}

#[test]
fn reset_clears_everything_and_requires_new_handshake() {
    let mut driver = driver_with_registry();
    import_chunk(&mut driver, (0, 0), 0);
    driver.send(update_batch(100, 100, &[(1, 1, 1, 1)]));
    assert_eq!(driver.session.health().loaded_chunks, 1);
    let generation_before = driver.session.mirror().generation();
    // Reset：清 chunks/pending/queued/desynced/registry READY + 重基序号
    assert_eq!(driver.reset().status, AckStatus::ResetApplied);
    let health = driver.session.health();
    assert_eq!(health.loaded_chunks, 0);
    assert_eq!(health.registry_ready, false);
    assert_eq!(health.last_transport_sequence, 0);
    assert_eq!(health.replay_window_len, 0);
    assert!(driver.session.mirror().generation() > generation_before);
    // registry 未重新握手 → chunk 流量 ResetRequired
    let ack = driver.send(MirrorMessage::ChunkBegin { chunk: (0, 0) });
    assert_eq!(ack.status, AckStatus::ResetRequired);
    // reset 造成的 desynced 已清，但再次违反屏障会重新置位
    assert!(driver.session.health().desynced);
    driver.reset();
    // 重新握手 → truth 重建与全新会话一致
    driver.send(registry_message(1, &[0b0111, 0b1011]));
    import_chunk(&mut driver, (0, 0), 0);
    assert_eq!(
        driver.session.mirror().snapshot_handle().query(1, 1, 1),
        CellQuery::Mask(0b0111)
    );
}

#[test]
fn semantic_rejection_consumes_transport_slot() {
    // §9 核心证明：新序号的语义拒绝消费槽位——下一条合法消息不误判为缺口。
    let mut driver = driver_with_registry();
    // SectionData 无开放导入 → SemanticRejected（槽位已消费）
    let ack = driver.send(MirrorMessage::SectionData {
        chunk: (0, 0),
        payload: data_payload(0, 0),
    });
    assert_eq!(ack.status, AckStatus::SemanticRejected);
    assert_eq!(ack.reason, Some(AckReason::NoOpenImport));
    // 下一条序号连续消息正常 Admit（若槽位未消费，这里会是 GapDesynced）
    import_chunk(&mut driver, (3, 3), 0);
    assert!(matches!(
        driver.session.mirror().snapshot_handle().query(49, 1, 49),
        CellQuery::Mask(_)
    ));
}

#[test]
fn gap_desync_fail_close_and_control_recovery() {
    let mut driver = driver_with_registry();
    // 缺口：seq 跳跃 → GapDesynced
    let ack = driver.submit(5, MirrorMessage::ChunkBegin { chunk: (0, 0) });
    assert_eq!(ack.status, AckStatus::GapDesynced);
    assert!(driver.session.health().desynced);
    // 恰好 last+1 的合法消息也被拒（fail-close 直到权威 Reset）
    let ack = driver.submit(2, MirrorMessage::ChunkUnload { chunk: (0, 0) });
    assert_eq!(ack.status, AckStatus::ResetRequired);
    // 普通数据消息不能触发隐式 Reset：控制面才行
    let ack = driver.reset();
    assert_eq!(ack.status, AckStatus::ResetApplied);
    assert!(!driver.session.health().desynced);
    // 重基后第一条必须 seq=1
    driver.sequence = 0;
    let ack = driver.send(registry_message(1, &[0b0111, 0b1011]));
    assert_eq!(ack.status, AckStatus::RegistryReady);
}

#[test]
fn control_stop_rejects_further_traffic() {
    let mut driver = driver_with_registry();
    assert_eq!(
        driver.session.submit_control(&MirrorControl::Stop).status,
        AckStatus::Stopping
    );
    let ack = driver.send(MirrorMessage::ChunkBegin { chunk: (0, 0) });
    assert_eq!(ack.status, AckStatus::Stopping);
    // Stop 后 Reset 也拒绝（会话终止，重启需新会话）
    let ack = driver.reset();
    assert_eq!(ack.status, AckStatus::Stopping);
}

#[test]
fn health_probe_reports_session_state() {
    let mut driver = driver_with_registry();
    import_chunk(&mut driver, (0, 0), 0);
    assert_eq!(
        driver
            .session
            .submit_control(&MirrorControl::HealthProbe)
            .status,
        AckStatus::Healthy
    );
    let health = driver.session.health();
    assert_eq!(health.loaded_chunks, 1);
    assert!(health.registry_ready);
    assert_eq!(health.registry_revision, 1);
    assert_eq!(health.last_transport_sequence, 4); // registry+begin+data+commit
    assert_eq!(health.replay_window_len, 4);
    assert!(!health.desynced);
    assert_eq!(health.skipped_updates_total, 0);
}

// ---------------------------------------------------------------------------
// 属性测试：随机增量序列的最终可查询状态 == 从最终声明全量重建。
// xorshift 确定性 PRNG（无外部依赖）。D2b 版：registry 先行 + batch +
// 权威 reset 后重握手；driver 保证 transport 序号连续（缺口语义由
// 专项测试覆盖）。
// ---------------------------------------------------------------------------

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
        let mut driver = Driver::new();
        driver.send(registry_message(1, &[0b0111, 0b1011]));
        let mut final_truth: HashMap<(i32, i32, i32), u32> = HashMap::new();
        let mut loaded: HashMap<ChunkKey, bool> = HashMap::new();
        for _step in 0..400 {
            let choice = rng.below(100);
            let chunk: ChunkKey = (rng.below(3) as i32, rng.below(3) as i32);
            if choice < 30 {
                // chunk 导入事务（section 0，fill 0/1）
                driver.send(MirrorMessage::ChunkBegin { chunk });
                driver.send(MirrorMessage::SectionData {
                    chunk,
                    payload: data_payload(0, rng.below(2) as u16),
                });
                driver.send(MirrorMessage::ChunkCommit { chunk });
                loaded.insert(chunk, true);
                // truth：该 chunk section 0 记录清回 fill 基线（fill 0→0b0111
                // 即 stateId 0；fill 1→表外 UNKNOWN）
                final_truth.retain(|pos, _| (pos.0 >> 4, pos.2 >> 4) != chunk);
            } else if choice < 50 {
                driver.send(MirrorMessage::ChunkUnload { chunk });
                loaded.insert(chunk, false);
                final_truth.retain(|pos, _| (pos.0 >> 4, pos.2 >> 4) != chunk);
            } else if choice < 90 {
                // batch：1-3 条 update（y∈0..16 → section 0 已导入）
                let count = 1 + rng.below(3);
                let mut entries = Vec::new();
                for _ in 0..count {
                    entries.push((
                        rng.below(48) as i32,
                        rng.below(16) as i32,
                        rng.below(48) as i32,
                        rng.below(4) as u32,
                    ));
                }
                let source_first = 100 + rng.below(1000);
                let source_last = source_first + rng.below(10);
                let ack = driver.send(update_batch(source_first, source_last, &entries));
                // 一切 outcome 都是合法协议结果；truth 只记已加载 chunk
                assert_ne!(ack.status, AckStatus::GapDesynced);
                assert_ne!(ack.status, AckStatus::ProtocolConflict);
                assert_ne!(ack.status, AckStatus::MalformedEnvelope);
                assert_ne!(ack.status, AckStatus::WrongEpoch);
                for &(x, y, z, state_id) in &entries {
                    let target = (x >> 4, z >> 4);
                    if loaded.get(&target).copied().unwrap_or(false) {
                        final_truth.insert((x, y, z), state_id);
                    }
                }
            } else {
                // 重放最后一条消息的精确内容（同序号同 payload）→
                // IgnoredDuplicate；状态与 truth 均不受影响。旧序号+不同
                // 内容=ProtocolConflict（fail-close），不属正常迟到路径。
                let (stale_sequence, stale_message) = driver.last_sent.clone();
                let ack = driver.submit(stale_sequence, stale_message);
                assert_eq!(ack.status, AckStatus::IgnoredDuplicate);
            }
        }
        // 对照：查询随机采样点
        let snapshot = driver.session.mirror().snapshot_handle();
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
                        "sample={sample} truth says loaded: {position:?}"
                    );
                }
                CellQuery::Mask(mask) => {
                    assert!(
                        truth_loaded,
                        "sample={sample} mirror says loaded but truth doesn't: {position:?}"
                    );
                    if let Some(&state_id) = final_truth.get(&position) {
                        let expect_mask = match state_id {
                            0 => 0b0111,
                            1 => 0b1011,
                            _ => CLASS_UNKNOWN_BIT,
                        };
                        assert_eq!(
                            mask, expect_mask,
                            "seed={seed} sample={sample} pos={position:?}"
                        );
                    }
                }
                CellQuery::Desynced => panic!("no desync in this scenario"),
            }
        }
    }
}
