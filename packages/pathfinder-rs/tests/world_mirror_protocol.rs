//! P5-D2a 协议外壳测试：admission gate / replay window / fingerprint /
//! legacy 迁移桥。覆盖 D2 指令 §21 清单：
//! 首条合法序号、连续序号、同序号同 payload duplicate、同序号不同
//! payload conflict、窗口内 duplicate、窗口外 stale、gap→desynced、
//! desynced 拒数据、wrong epoch 不推进、unsupported protocol 不推进、
//! admission 即消费槽位、malformed envelope、有界 replay 内存、
//! fingerprint 稳定、大 section fingerprint 零复制（借用式设计）。

use pathfinder_rs::world_mirror_protocol::*;

fn envelope(sequence: u64, message: MirrorMessage) -> MirrorEnvelope {
    MirrorEnvelope {
        protocol_version: MIRROR_PROTOCOL_VERSION,
        session_epoch: 7,
        dimension_epoch: 1,
        transport_sequence: sequence,
        message,
    }
}

fn begin(chunk: (i32, i32)) -> MirrorMessage {
    MirrorMessage::ChunkBegin { chunk }
}

fn batch_one(x: i32, state_id: u32) -> MirrorMessage {
    MirrorMessage::BlockUpdateBatch {
        source_first_sequence: 100,
        source_last_sequence: 100,
        source_event_count: 1,
        coalesced_event_count: None,
        updates: vec![BlockUpdateEntry {
            position: (x, 1, 1),
            state_id,
        }],
    }
}

#[test]
fn first_legal_sequence_and_consecutive() {
    let mut gate = AdmissionGate::new(7, 1);
    assert_eq!(
        gate.admit(&envelope(1, begin((0, 0)))),
        AdmissionVerdict::Admit
    );
    assert_eq!(gate.last_sequence(), 1);
    assert_eq!(
        gate.admit(&envelope(2, begin((1, 1)))),
        AdmissionVerdict::Admit
    );
    assert_eq!(
        gate.admit(&envelope(3, begin((2, 2)))),
        AdmissionVerdict::Admit
    );
    assert_eq!(gate.last_sequence(), 3);
}

#[test]
fn same_sequence_same_payload_is_duplicate() {
    let mut gate = AdmissionGate::new(7, 1);
    gate.admit(&envelope(1, begin((0, 0))));
    // 重放同序号同内容（即使中间已推进到 2）→ 幂等 duplicate，不 desync。
    gate.admit(&envelope(2, begin((1, 1))));
    assert_eq!(
        gate.admit(&envelope(1, begin((0, 0)))),
        AdmissionVerdict::IgnoredDuplicate
    );
    assert!(!gate.is_desynced());
    // 序号未被 duplicate 干扰
    assert_eq!(
        gate.admit(&envelope(3, begin((3, 3)))),
        AdmissionVerdict::Admit
    );
}

#[test]
fn same_sequence_different_payload_is_protocol_conflict() {
    let mut gate = AdmissionGate::new(7, 1);
    gate.admit(&envelope(1, begin((0, 0))));
    assert_eq!(
        gate.admit(&envelope(1, begin((9, 9)))),
        AdmissionVerdict::ProtocolConflict
    );
    assert!(gate.is_desynced());
    // 冲突不推进序号（高水位保留）
    assert_eq!(gate.last_sequence(), 1);
}

#[test]
fn duplicate_within_replay_window_and_stale_outside() {
    let mut gate = AdmissionGate::with_replay_capacity(7, 1, 4);
    for seq in 1..=6u64 {
        assert_eq!(
            gate.admit(&envelope(seq, begin((seq as i32, 0)))),
            AdmissionVerdict::Admit
        );
    }
    // 窗口容量 4：只保留 3..=6。seq=5 在窗口内且同 payload → duplicate。
    assert_eq!(
        gate.admit(&envelope(5, begin((5, 0)))),
        AdmissionVerdict::IgnoredDuplicate
    );
    // seq=2 已被挤出窗口 → 窗口外 stale（正常结果，不 desync）。
    assert_eq!(
        gate.admit(&envelope(2, begin((2, 0)))),
        AdmissionVerdict::IgnoredStale
    );
    assert!(!gate.is_desynced());
    assert_eq!(gate.replay_floor(), Some(3));
}

#[test]
fn gap_marks_desynced_and_data_rejected_until_reset() {
    let mut gate = AdmissionGate::new(7, 1);
    gate.admit(&envelope(1, begin((0, 0))));
    assert_eq!(
        gate.admit(&envelope(5, begin((1, 1)))),
        AdmissionVerdict::GapDesynced
    );
    assert!(gate.is_desynced());
    // 缺口后：恰好 last+1 的合法消息也被拒（fail-close 直到权威 Reset）
    assert_eq!(
        gate.admit(&envelope(2, begin((1, 1)))),
        AdmissionVerdict::RejectedDesynced
    );
    // 高水位不推进
    assert_eq!(gate.last_sequence(), 1);
    // 权威 Reset（epoch 前进性由上层校验）：重基序号
    gate.apply_reset(8, 1);
    assert!(!gate.is_desynced());
    assert_eq!(gate.replay_len(), 0);
    let envelope8 = |sequence: u64, message: MirrorMessage| MirrorEnvelope {
        protocol_version: MIRROR_PROTOCOL_VERSION,
        session_epoch: 8,
        dimension_epoch: 1,
        transport_sequence: sequence,
        message,
    };
    // 重基后第一条必须是 seq=1（新 epoch）
    assert_eq!(
        gate.admit(&envelope8(1, begin((0, 0)))),
        AdmissionVerdict::Admit
    );
    // 旧 epoch 信封 → WrongEpoch（不消费 seq=2）
    assert_eq!(
        gate.admit(&envelope(2, begin((1, 1)))),
        AdmissionVerdict::WrongEpoch
    );
    assert_eq!(
        gate.admit(&envelope8(2, begin((1, 1)))),
        AdmissionVerdict::Admit
    );
}

#[test]
fn wrong_epoch_and_unsupported_protocol_do_not_advance() {
    let mut gate = AdmissionGate::new(7, 1);
    gate.admit(&envelope(1, begin((0, 0))));
    // wrong session epoch（seq=2 不消费）
    let mut wrong_session = envelope(2, begin((1, 1)));
    wrong_session.session_epoch = 6;
    assert_eq!(gate.admit(&wrong_session), AdmissionVerdict::WrongEpoch);
    // wrong dimension epoch（seq=2 不消费）
    let mut wrong_dimension = envelope(2, begin((1, 1)));
    wrong_dimension.dimension_epoch = 0;
    assert_eq!(gate.admit(&wrong_dimension), AdmissionVerdict::WrongEpoch);
    // unsupported protocol（seq=2 不消费）
    let mut bad_protocol = envelope(2, begin((1, 1)));
    bad_protocol.protocol_version = MIRROR_PROTOCOL_VERSION + 1;
    assert_eq!(
        gate.admit(&bad_protocol),
        AdmissionVerdict::UnsupportedProtocol
    );
    // 同一 seq=2 的正确信封仍可 Admit（前三次均未消费槽位）
    assert_eq!(
        gate.admit(&envelope(2, begin((1, 1)))),
        AdmissionVerdict::Admit
    );
}

#[test]
fn malformed_envelope_does_not_advance() {
    let mut gate = AdmissionGate::new(7, 1);
    gate.admit(&envelope(1, begin((0, 0))));
    // transportSequence=0 → 非法信封
    assert_eq!(
        gate.admit(&envelope(0, begin((1, 1)))),
        AdmissionVerdict::MalformedEnvelope
    );
    // Data section 长度 != 4096 → payload 结构损坏（无法规范化 fingerprint）
    let bad_section = MirrorMessage::SectionData {
        chunk: (0, 0),
        payload: SectionPayload::Data {
            section_y: 0,
            palette_indices: vec![0u16; 100].into_boxed_slice(),
            palette_entries: vec![1],
        },
    };
    assert_eq!(
        gate.admit(&envelope(2, bad_section)),
        AdmissionVerdict::MalformedEnvelope
    );
    // palette 索引越界 → 同上
    let bad_index = MirrorMessage::SectionData {
        chunk: (0, 0),
        payload: SectionPayload::Data {
            section_y: 0,
            palette_indices: vec![5u16; SECTION_CELLS].into_boxed_slice(),
            palette_entries: vec![1],
        },
    };
    assert_eq!(
        gate.admit(&envelope(2, bad_index)),
        AdmissionVerdict::MalformedEnvelope
    );
    // 空 batch / 反转 source 区间 / 空注册表 → 结构非法
    let empty_batch = MirrorMessage::BlockUpdateBatch {
        source_first_sequence: 1,
        source_last_sequence: 2,
        source_event_count: 2,
        coalesced_event_count: None,
        updates: vec![],
    };
    assert_eq!(
        gate.admit(&envelope(2, empty_batch)),
        AdmissionVerdict::MalformedEnvelope
    );
    let inverted = MirrorMessage::BlockUpdateBatch {
        source_first_sequence: 5,
        source_last_sequence: 4,
        source_event_count: 2,
        coalesced_event_count: None,
        updates: vec![BlockUpdateEntry {
            position: (0, 1, 0),
            state_id: 1,
        }],
    };
    assert_eq!(
        gate.admit(&envelope(2, inverted)),
        AdmissionVerdict::MalformedEnvelope
    );
    let empty_registry = MirrorMessage::RegistryTable {
        revision: 1,
        masks: vec![],
        minecraft_version: None,
        server_profile_id: None,
    };
    assert_eq!(
        gate.admit(&envelope(2, empty_registry)),
        AdmissionVerdict::MalformedEnvelope
    );
    // 全部 malformed 均未消费 seq=2
    assert_eq!(
        gate.admit(&envelope(2, begin((1, 1)))),
        AdmissionVerdict::Admit
    );
}

#[test]
fn admission_consumes_slot_even_before_business_apply() {
    // §9：槽位在 admission 记录（先记 fingerprint 再放行 apply）——
    // 业务层即使 SemanticRejected 也不回收。gate 层证明：Admit 判定返回
    // 后立刻重放同序号同内容，即使"apply 从未发生"也是 duplicate。
    let mut gate = AdmissionGate::new(7, 1);
    assert_eq!(
        gate.admit(&envelope(1, begin((0, 0)))),
        AdmissionVerdict::Admit
    );
    // （调用方此刻尚未 apply——重放即 duplicate）
    assert_eq!(
        gate.admit(&envelope(1, begin((0, 0)))),
        AdmissionVerdict::IgnoredDuplicate
    );
    // 且窗口内已有记录
    assert_eq!(gate.replay_len(), 1);
}

#[test]
fn replay_window_memory_bounded() {
    let capacity = 8;
    let mut window = ReplayWindow::new(capacity);
    for seq in 1..=1000u64 {
        window.record(seq, seq.wrapping_mul(0x9e37_79b9));
        assert!(window.len() <= capacity, "replay window must stay bounded");
    }
    // 只保留最近 capacity 条；最旧的被挤出 → stale 范围
    assert_eq!(window.len(), capacity);
    assert_eq!(window.floor(), Some(1000 - capacity as u64 + 1));
    assert!(window.lookup(1).is_none());
    assert!(window.lookup(1000).is_some());
    window.clear();
    assert_eq!(window.len(), 0);
}

#[test]
fn fingerprint_stable_and_field_sensitive() {
    let registry_a = MirrorMessage::RegistryTable {
        revision: 3,
        masks: vec![0b0111, 0b1011],
        minecraft_version: Some("1.21.11".to_string()),
        server_profile_id: Some("luv-anarchy".to_string()),
    };
    let registry_a2 = registry_a.clone(); // 独立构造的等值消息
    assert_eq!(
        payload_fingerprint(&registry_a),
        payload_fingerprint(&registry_a2)
    );
    // 任一字段变化 → 不同 fingerprint
    let registry_rev = MirrorMessage::RegistryTable {
        revision: 4,
        masks: vec![0b0111, 0b1011],
        minecraft_version: Some("1.21.11".to_string()),
        server_profile_id: Some("luv-anarchy".to_string()),
    };
    let registry_mask = MirrorMessage::RegistryTable {
        revision: 3,
        masks: vec![0b0111, 0b1111],
        minecraft_version: Some("1.21.11".to_string()),
        server_profile_id: Some("luv-anarchy".to_string()),
    };
    let registry_profile = MirrorMessage::RegistryTable {
        revision: 3,
        masks: vec![0b0111, 0b1011],
        minecraft_version: Some("1.21.11".to_string()),
        server_profile_id: Some("other".to_string()),
    };
    let base = payload_fingerprint(&registry_a);
    assert_ne!(base, payload_fingerprint(&registry_rev));
    assert_ne!(base, payload_fingerprint(&registry_mask));
    assert_ne!(base, payload_fingerprint(&registry_profile));
    // kind 标签参与：同 chunk 的 ChunkBegin ≠ ChunkCommit
    assert_ne!(
        payload_fingerprint(&begin((0, 0))),
        payload_fingerprint(&MirrorMessage::ChunkCommit { chunk: (0, 0) })
    );
    // 批次：source 范围参与（updates 相同、范围不同 → 不同值）
    let batch_range_a = MirrorMessage::BlockUpdateBatch {
        source_first_sequence: 101,
        source_last_sequence: 103,
        source_event_count: 3,
        coalesced_event_count: Some(2),
        updates: vec![BlockUpdateEntry {
            position: (1, 1, 1),
            state_id: 5,
        }],
    };
    let batch_range_b = MirrorMessage::BlockUpdateBatch {
        source_first_sequence: 101,
        source_last_sequence: 110,
        source_event_count: 10,
        coalesced_event_count: Some(2),
        updates: vec![BlockUpdateEntry {
            position: (1, 1, 1),
            state_id: 5,
        }],
    };
    assert_ne!(
        payload_fingerprint(&batch_range_a),
        payload_fingerprint(&batch_range_b)
    );
}

#[test]
fn big_section_fingerprint_reads_borrow_zero_copy() {
    // 大 section（4096 格）fingerprint：payload_fingerprint 接收 &MirrorMessage
    // （借用式只读遍历，编译期保证零复制——本测试验证内容敏感 + 两次一致）。
    let mut indices = vec![0u16; SECTION_CELLS].into_boxed_slice();
    indices[1234] = 7;
    indices[4095] = 1;
    let message_a = MirrorMessage::SectionData {
        chunk: (3, -2),
        payload: SectionPayload::Data {
            section_y: -4,
            palette_indices: indices,
            palette_entries: vec![0b0111, 0b1011, CLASS_UNKNOWN_BIT],
        },
    };
    let mut indices_b = vec![0u16; SECTION_CELLS].into_boxed_slice();
    indices_b[1234] = 7;
    indices_b[4095] = 1;
    let message_b = MirrorMessage::SectionData {
        chunk: (3, -2),
        payload: SectionPayload::Data {
            section_y: -4,
            palette_indices: indices_b,
            palette_entries: vec![0b0111, 0b1011, CLASS_UNKNOWN_BIT],
        },
    };
    assert_eq!(
        payload_fingerprint(&message_a),
        payload_fingerprint(&message_b)
    );
    // 单格变化即不同
    let mut indices_c = vec![0u16; SECTION_CELLS].into_boxed_slice();
    indices_c[1234] = 7;
    indices_c[4095] = 2;
    let message_c = MirrorMessage::SectionData {
        chunk: (3, -2),
        payload: SectionPayload::Data {
            section_y: -4,
            palette_indices: indices_c,
            palette_entries: vec![0b0111, 0b1011, CLASS_UNKNOWN_BIT],
        },
    };
    assert_ne!(
        payload_fingerprint(&message_a),
        payload_fingerprint(&message_c)
    );
    // palette 条目表内容参与
    let message_d = MirrorMessage::SectionData {
        chunk: (3, -2),
        payload: SectionPayload::Data {
            section_y: -4,
            palette_indices: vec![7u16; SECTION_CELLS].into_boxed_slice(),
            palette_entries: vec![0b0111, 0b1011, CLASS_UNKNOWN_BIT],
        },
    };
    let message_e = MirrorMessage::SectionData {
        chunk: (3, -2),
        payload: SectionPayload::Data {
            section_y: -4,
            palette_indices: vec![7u16; SECTION_CELLS].into_boxed_slice(),
            palette_entries: vec![0b0111, 0b1111, CLASS_UNKNOWN_BIT],
        },
    };
    assert_ne!(
        payload_fingerprint(&message_d),
        payload_fingerprint(&message_e)
    );
}

#[test]
fn section_payload_helpers() {
    assert_eq!(
        SectionPayload::Empty {
            section_y: 5,
            fill_state_id: 0
        }
        .section_y(),
        5
    );
    assert_eq!(SectionPayload::NotPresent { section_y: -4 }.section_y(), -4);
}

#[test]
fn gate_replay_fingerprint_echo() {
    let mut gate = AdmissionGate::new(7, 1);
    gate.admit(&envelope(1, begin((0, 0))));
    assert_eq!(
        gate.replay_fingerprint(1),
        Some(payload_fingerprint(&begin((0, 0))))
    );
    assert_eq!(gate.replay_fingerprint(99), None);
}
