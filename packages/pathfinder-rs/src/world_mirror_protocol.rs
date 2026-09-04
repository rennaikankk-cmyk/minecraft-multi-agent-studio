//! world_mirror_protocol.rs —— P5-D2a：WorldMirror 传输协议外壳（独立模块）。
//!
//! 分层（P5-D2 指令 §5——传输字段不散落到业务 variant）：
//!   MirrorEnvelope  传输信封：protocolVersion + epoch + transportSequence + 业务消息
//!   MirrorMessage   业务消息：不含传输字段（序号/epoch 只在信封）
//!   MirrorControl   恢复控制面：Reset/Stop/HealthProbe——独立恢复规则，不走序号闸
//!   MirrorAck       结构化回执：固定状态枚举 + 固定 reason + 关联序号/epoch
//!
//! AdmissionGate（§7/§9 的 admission 顺序）：
//!   1. envelope 结构可解析（含 payload 结构有效性）→ 否则 MalformedEnvelope
//!   2. protocolVersion 受支持 → 否则 UnsupportedProtocol
//!   3. epoch 正确 → 否则 WrongEpoch
//!   4. transport sequence 分类 + payload fingerprint replay 检测
//!      - seq == last+1 → Admit（**先记录 seq/fingerprint 再放行业务 apply**
//!        ——语义拒绝也消费槽位，下一条合法消息不被误判为缺口）
//!      - 同 seq + 同 fingerprint（replay 窗口内）→ IgnoredDuplicate（正常结果）
//!      - 同 seq + 不同 fingerprint → ProtocolConflict（置 Desynced）
//!      - 窗口外更旧 seq → IgnoredStale（正常结果）
//!      - seq > last+1 → GapDesynced（置 Desynced，高水位保留诊断）
//!   5. Desynced 期间拒绝一切普通数据消息（直到权威 Reset）
//!   MalformedEnvelope/UnsupportedProtocol/WrongEpoch/gap/conflict 均不推进序号。
//!
//! payload fingerprint（§8）：FNV-1a 64 对规范化字段序（kind 标签 + 逐字段
//! 定序写入，section 数据逐项只读遍历，零复制）。非密码学：碰撞策略=
//! 64 位空间下 ≤2^32 条消息生日碰撞概率 ~10^-10，碰撞最坏后果是把极小
//! 概率的不同消息误判为 duplicate（fail 方向是保留既有状态，不崩溃、
//! 不放大写入）。Rust 结构体无键序问题；若未来走 JSON 边界必须先显式
//! 规范化字段顺序再 hash，禁止直接 hash 任意序列化串。
//!
//! replay window：只存 (sequence, fingerprint) 定长对（capacity × 16B 有界），
//! 绝不保存 section payload——重复检测不需要内容本身。

use std::collections::VecDeque;

pub use crate::world_mirror::{BlockClassMask, ChunkKey, CLASS_UNKNOWN_BIT};

/// 传输协议版本（Envelope.protocol_version 必须精确等于此值）。
pub const MIRROR_PROTOCOL_VERSION: u32 = 1;

/// 单个 section 的格子数（1.18+ 固定 16³）。
pub const SECTION_CELLS: usize = 4096;

/// replay window 默认容量（可配置；每项 16B → 默认 ~16KB 常驻）。
pub const DEFAULT_REPLAY_CAPACITY: usize = 1024;

/// 单条 block update：携带**绝对最终 stateId**（同坐标合并/重放幂等的基础）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct BlockUpdateEntry {
    pub position: (i32, i32, i32),
    pub state_id: u32,
}

/// Section 载荷三态（§11）。Empty 必须带显式 fillStateId 并经 RegistryTable
/// 分类——prismarine 缺席≠空气，Rust 不硬编码 stateId 0 的语义。
/// NotPresent 只描述存储形态（prismarine sections[i] 无对象），不自动等于
/// AIR/UNKNOWN/Empty。
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum SectionPayload {
    Data {
        section_y: i32,
        /// 长 4096 的 palette 索引（TS 提取器负责 stateId→class mask→去重索引）。
        palette_indices: Box<[u16]>,
        /// 本 section 引用的 palette 条目（class mask 列表；commit 时并入全局表）。
        palette_entries: Vec<BlockClassMask>,
    },
    Empty {
        section_y: i32,
        /// 显式填充 stateId（经 RegistryTable 分类；表外 → UNKNOWN 位）。
        fill_state_id: u32,
    },
    NotPresent {
        section_y: i32,
    },
}

impl SectionPayload {
    pub fn section_y(&self) -> i32 {
        match self {
            SectionPayload::Data { section_y, .. }
            | SectionPayload::Empty { section_y, .. }
            | SectionPayload::NotPresent { section_y } => *section_y,
        }
    }
}

/// 业务消息（不含传输字段）。BlockUpdateBatch 保留 source 事件序号范围
/// （§6 双序号：sourceEventSequence 允许因同坐标合并不连续，transport gate
/// 不得要求其连续——连续性只作用于 transportSequence）。
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum MirrorMessage {
    RegistryTable {
        revision: u64,
        /// stateId → class mask 全表（索引即 stateId；表外 stateId → UNKNOWN 位）。
        masks: Vec<BlockClassMask>,
        minecraft_version: Option<String>,
        server_profile_id: Option<String>,
    },
    ChunkBegin {
        chunk: ChunkKey,
    },
    SectionData {
        chunk: ChunkKey,
        payload: SectionPayload,
    },
    ChunkCommit {
        chunk: ChunkKey,
    },
    ChunkUnload {
        chunk: ChunkKey,
    },
    BlockUpdateBatch {
        /// 本批覆盖的源事件序号闭区间（合并后只发最终值，区间允许空洞）。
        source_first_sequence: u64,
        source_last_sequence: u64,
        /// 本批覆盖的源事件总数（≥ updates.len，差额=被合并丢弃）。
        source_event_count: u64,
        /// 可选：被合并丢弃的事件数（审计用）。
        coalesced_event_count: Option<u64>,
        updates: Vec<BlockUpdateEntry>,
    },
}

/// 恢复控制面。不走传输序号闸——Reset 由 TS session supervisor 发起，
/// epoch 权威在 TS；Rust 只校验（严格前进）并回显，绝不自行生成 epoch。
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum MirrorControl {
    /// 权威重置：new_session/new_dimension 至少其一严格大于当前值。
    /// 原子清空全部镜像状态、清除 Desynced、重基 transportSequence、
    /// 清除 registry READY——之后必须重新 Registry 握手再重建 chunk truth。
    WorldReset {
        new_session_epoch: u64,
        new_dimension_epoch: u64,
        reason: WorldResetReason,
        /// 一次性 resync token（诊断关联；Rust 不解释语义）。
        resync_token: u64,
    },
    Stop,
    HealthProbe,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WorldResetReason {
    SessionRestart,
    DimensionChange,
    DesyncRecovery,
    OperatorRequest,
}

/// 传输信封——所有普通数据消息的唯一外层形态。
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct MirrorEnvelope {
    pub protocol_version: u32,
    pub session_epoch: u64,
    pub dimension_epoch: u64,
    pub transport_sequence: u64,
    pub message: MirrorMessage,
}

/// 回执状态（§7 十态 + 控制面回执；实际枚举名按仓库规范转换）。
/// IgnoredDuplicate/正当 IgnoredStale 是正常协议结果，不导出高严重度 Incident。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AckStatus {
    Applied,
    /// 业务前置条件不满足（chunk 不存在/revision 不匹配/section 重复等）
    /// ——传输槽位已被 admission 消费。
    SemanticRejected,
    IgnoredDuplicate,
    IgnoredStale,
    GapDesynced,
    ProtocolConflict,
    WrongEpoch,
    UnsupportedProtocol,
    MalformedEnvelope,
    /// 协议顺序错误（如 RegistryReady 前收到 chunk）——数据已丢，必须
    /// Reset→Registry 握手→truth 重建，不能当普通拒绝继续。
    ResetRequired,
    /// 导入事务期间到达的 batch：已按 source 序号排队，COMMIT 后重放。
    QueuedUntilCommit,
    // ---- 控制面回执 ----
    ResetApplied,
    /// RegistryTable 安装成功的握手回执（revision + 表 fingerprint 供 TS 核对）。
    RegistryReady,
    Stopping,
    Healthy,
}

/// 固定 reason code（结构化，不携带自由文本）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AckReason {
    ChunkNotLoaded,
    NoOpenImport,
    RegistryNotReady,
    RegistryMismatch,
    InvalidSectionLength,
    UpdateOutsideLoadedChunk,
    /// Reset 的 epoch 未严格前进（更旧/同 epoch 迟到 Reset）。
    EpochNotAdvanced,
}

/// 结构化 ACK（§15）。transport_sequence 对控制面回执为 0（control 不占传输槽）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct MirrorAck {
    pub protocol_version: u32,
    pub session_epoch: u64,
    pub dimension_epoch: u64,
    pub transport_sequence: u64,
    pub status: AckStatus,
    pub mirror_generation: u64,
    pub registry_revision: Option<u64>,
    pub chunk_revision: Option<u64>,
    pub reason: Option<AckReason>,
    /// admission 记录的 payload fingerprint（RegistryReady=表 fingerprint；
    /// duplicate/conflict=窗口内存储值）——TS 据此核对。
    pub payload_fingerprint: Option<u64>,
    /// 批次中被跳过的 update 数（目标 chunk 未加载/非 Data section——
    /// 可观测不静默；正常稳态应为 0）。
    pub skipped_updates: Option<u64>,
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

#[derive(Clone, Copy)]
struct Fnv1a64(u64);

impl Fnv1a64 {
    fn new() -> Self {
        Fnv1a64(FNV_OFFSET_BASIS)
    }
    fn write_u8(&mut self, byte: u8) {
        self.0 ^= u64::from(byte);
        self.0 = self.0.wrapping_mul(FNV_PRIME);
    }
    fn write_u16(&mut self, value: u16) {
        for byte in value.to_le_bytes() {
            self.write_u8(byte);
        }
    }
    fn write_u32(&mut self, value: u32) {
        for byte in value.to_le_bytes() {
            self.write_u8(byte);
        }
    }
    fn write_u64(&mut self, value: u64) {
        for byte in value.to_le_bytes() {
            self.write_u8(byte);
        }
    }
    fn write_i32(&mut self, value: i32) {
        for byte in value.to_le_bytes() {
            self.write_u8(byte);
        }
    }
    /// 长度前缀防字段拼接歧义（"ab"+"c" ≠ "a"+"bc"）。
    fn write_str(&mut self, value: &str) {
        self.write_u64(value.len() as u64);
        for &byte in value.as_bytes() {
            self.write_u8(byte);
        }
    }
    fn write_option_str(&mut self, value: &Option<String>) {
        match value {
            Some(text) => {
                self.write_u8(1);
                self.write_str(text);
            }
            None => self.write_u8(0),
        }
    }
    fn finish(self) -> u64 {
        self.0
    }
}

const MSG_REGISTRY_TABLE: u8 = 1;
const MSG_CHUNK_BEGIN: u8 = 2;
const MSG_SECTION_DATA: u8 = 3;
const MSG_CHUNK_COMMIT: u8 = 4;
const MSG_CHUNK_UNLOAD: u8 = 5;
const MSG_BLOCK_UPDATE_BATCH: u8 = 6;
const PAYLOAD_DATA: u8 = 1;
const PAYLOAD_EMPTY: u8 = 2;
const PAYLOAD_NOT_PRESENT: u8 = 3;

/// 规范化 payload fingerprint：覆盖 message kind + 完整业务字段（含
/// section 数据内容、registry revision 与表内容）。只读遍历，零复制；
/// 不包含接收时间等本地状态（同消息重放必得同值）。
pub fn payload_fingerprint(message: &MirrorMessage) -> u64 {
    let mut h = Fnv1a64::new();
    match message {
        MirrorMessage::RegistryTable {
            revision,
            masks,
            minecraft_version,
            server_profile_id,
        } => {
            h.write_u8(MSG_REGISTRY_TABLE);
            h.write_u64(*revision);
            h.write_u64(masks.len() as u64);
            for &mask in masks {
                h.write_u32(mask);
            }
            h.write_option_str(minecraft_version);
            h.write_option_str(server_profile_id);
        }
        MirrorMessage::ChunkBegin { chunk } => {
            h.write_u8(MSG_CHUNK_BEGIN);
            h.write_i32(chunk.0);
            h.write_i32(chunk.1);
        }
        MirrorMessage::SectionData { chunk, payload } => {
            h.write_u8(MSG_SECTION_DATA);
            h.write_i32(chunk.0);
            h.write_i32(chunk.1);
            match payload {
                SectionPayload::Data {
                    section_y,
                    palette_indices,
                    palette_entries,
                } => {
                    h.write_u8(PAYLOAD_DATA);
                    h.write_i32(*section_y);
                    h.write_u64(palette_indices.len() as u64);
                    for &index in palette_indices.iter() {
                        h.write_u16(index);
                    }
                    h.write_u64(palette_entries.len() as u64);
                    for &mask in palette_entries {
                        h.write_u32(mask);
                    }
                }
                SectionPayload::Empty {
                    section_y,
                    fill_state_id,
                } => {
                    h.write_u8(PAYLOAD_EMPTY);
                    h.write_i32(*section_y);
                    h.write_u32(*fill_state_id);
                }
                SectionPayload::NotPresent { section_y } => {
                    h.write_u8(PAYLOAD_NOT_PRESENT);
                    h.write_i32(*section_y);
                }
            }
        }
        MirrorMessage::ChunkCommit { chunk } => {
            h.write_u8(MSG_CHUNK_COMMIT);
            h.write_i32(chunk.0);
            h.write_i32(chunk.1);
        }
        MirrorMessage::ChunkUnload { chunk } => {
            h.write_u8(MSG_CHUNK_UNLOAD);
            h.write_i32(chunk.0);
            h.write_i32(chunk.1);
        }
        MirrorMessage::BlockUpdateBatch {
            source_first_sequence,
            source_last_sequence,
            source_event_count,
            coalesced_event_count,
            updates,
        } => {
            h.write_u8(MSG_BLOCK_UPDATE_BATCH);
            h.write_u64(*source_first_sequence);
            h.write_u64(*source_last_sequence);
            h.write_u64(*source_event_count);
            match coalesced_event_count {
                Some(count) => {
                    h.write_u8(1);
                    h.write_u64(*count);
                }
                None => h.write_u8(0),
            }
            h.write_u64(updates.len() as u64);
            for entry in updates {
                h.write_i32(entry.position.0);
                h.write_i32(entry.position.1);
                h.write_i32(entry.position.2);
                h.write_u32(entry.state_id);
            }
        }
    }
    h.finish()
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// （无法可靠规范化/fingerprint），不消费传输槽；业务前置条件（chunk 存在等）
// 属 SemanticRejected，由业务层在 admission 之后判定（§9）。
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StructureError {
    /// transportSequence 从 1 开始；0 是非法信封。
    ZeroTransportSequence,
    InvalidSectionLength {
        len: usize,
    },
    PaletteIndexOutOfRange {
        index: u16,
        entries: usize,
    },
    PaletteEntriesEmpty,
    EmptyBatch,
    InvertedSourceRange,
    EmptyRegistryTable,
}

pub fn validate_envelope_structure(envelope: &MirrorEnvelope) -> Result<(), StructureError> {
    if envelope.transport_sequence == 0 {
        return Err(StructureError::ZeroTransportSequence);
    }
    validate_message_structure(&envelope.message)
}

pub fn validate_message_structure(message: &MirrorMessage) -> Result<(), StructureError> {
    match message {
        MirrorMessage::RegistryTable { masks, .. } => {
            if masks.is_empty() {
                Err(StructureError::EmptyRegistryTable)
            } else {
                Ok(())
            }
        }
        MirrorMessage::SectionData {
            payload:
                SectionPayload::Data {
                    palette_indices,
                    palette_entries,
                    ..
                },
            ..
        } => {
            if palette_indices.len() != SECTION_CELLS {
                return Err(StructureError::InvalidSectionLength {
                    len: palette_indices.len(),
                });
            }
            if palette_entries.is_empty() {
                return Err(StructureError::PaletteEntriesEmpty);
            }
            for &index in palette_indices.iter() {
                if index as usize >= palette_entries.len() {
                    return Err(StructureError::PaletteIndexOutOfRange {
                        index,
                        entries: palette_entries.len(),
                    });
                }
            }
            Ok(())
        }
        MirrorMessage::BlockUpdateBatch {
            source_first_sequence,
            source_last_sequence,
            source_event_count,
            updates,
            ..
        } => {
            if updates.is_empty() {
                return Err(StructureError::EmptyBatch);
            }
            if source_last_sequence < source_first_sequence || *source_event_count == 0 {
                return Err(StructureError::InvertedSourceRange);
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
#[derive(Debug)]
pub struct ReplayWindow {
    entries: VecDeque<(u64, u64)>,
    capacity: usize,
}

impl ReplayWindow {
    pub fn new(capacity: usize) -> Self {
        ReplayWindow {
            entries: VecDeque::new(),
            capacity: capacity.max(1),
        }
    }

    pub fn record(&mut self, sequence: u64, fingerprint: u64) {
        if self.entries.len() == self.capacity {
            self.entries.pop_front();
        }
        self.entries.push_back((sequence, fingerprint));
    }

    /// 倒序短路查找（新→旧）；窗口容量上限内线性扫描，µs 级。
    pub fn lookup(&self, sequence: u64) -> Option<u64> {
        self.entries
            .iter()
            .rev()
            .find(|(seq, _)| *seq == sequence)
            .map(|(_, fp)| *fp)
    }

    /// 窗口内最旧 sequence（seq 低于它的重放按 IgnoredStale 处理）。
    pub fn floor(&self) -> Option<u64> {
        self.entries.front().map(|(seq, _)| *seq)
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AdmissionVerdict {
    /// seq == last+1：槽位已在 admission 消费（先记录后 apply——语义拒绝
    /// 不回收，下一条合法消息不被误判为缺口）。
    Admit,
    IgnoredDuplicate,
    ProtocolConflict,
    IgnoredStale,
    GapDesynced,
    WrongEpoch,
    UnsupportedProtocol,
    MalformedEnvelope,
    /// 已 Desynced：拒绝一切普通数据消息（直到权威 Reset）。
    RejectedDesynced,
}

#[derive(Debug)]
pub struct AdmissionGate {
    session_epoch: u64,
    dimension_epoch: u64,
    last_sequence: u64,
    desynced: bool,
    replay: ReplayWindow,
}

impl AdmissionGate {
    pub fn new(session_epoch: u64, dimension_epoch: u64) -> Self {
        AdmissionGate {
            session_epoch,
            dimension_epoch,
            last_sequence: 0,
            desynced: false,
            replay: ReplayWindow::new(DEFAULT_REPLAY_CAPACITY),
        }
    }

    pub fn with_replay_capacity(session_epoch: u64, dimension_epoch: u64, capacity: usize) -> Self {
        AdmissionGate {
            replay: ReplayWindow::new(capacity),
            ..AdmissionGate::new(session_epoch, dimension_epoch)
        }
    }

    /// admission 判定（顺序：结构 → 协议版本 → epoch → 序号/fingerprint）。
    /// Admit 时槽位与 fingerprint 已记录；其余一切路径不推进序号。
    pub fn admit(&mut self, envelope: &MirrorEnvelope) -> AdmissionVerdict {
        if validate_envelope_structure(envelope).is_err() {
            return AdmissionVerdict::MalformedEnvelope;
        }
        if envelope.protocol_version != MIRROR_PROTOCOL_VERSION {
            return AdmissionVerdict::UnsupportedProtocol;
        }
        if envelope.session_epoch != self.session_epoch
            || envelope.dimension_epoch != self.dimension_epoch
        {
            return AdmissionVerdict::WrongEpoch;
        }
        if self.desynced {
            return AdmissionVerdict::RejectedDesynced;
        }
        let sequence = envelope.transport_sequence;
        if sequence == self.last_sequence + 1 {
            // 先记录（§9：语义拒绝也消费），后放行业务。
            let fingerprint = payload_fingerprint(&envelope.message);
            self.replay.record(sequence, fingerprint);
            self.last_sequence = sequence;
            return AdmissionVerdict::Admit;
        }
        if sequence <= self.last_sequence {
            return match self.replay.lookup(sequence) {
                Some(stored) => {
                    if stored == payload_fingerprint(&envelope.message) {
                        AdmissionVerdict::IgnoredDuplicate
                    } else {
                        self.desynced = true;
                        AdmissionVerdict::ProtocolConflict
                    }
                }
                None => AdmissionVerdict::IgnoredStale,
            };
        }
        // sequence > last+1：缺口，fail-close（保留高水位诊断，不推进）。
        self.desynced = true;
        AdmissionVerdict::GapDesynced
    }

    /// 权威 Reset 后的闸重置：重基序号（下一条必须为 1）、清窗口、清
    /// Desynced、epoch 前进。epoch 前进性校验由调用方（MirrorSession）
    /// 在调用前完成——闸只执行。
    pub fn apply_reset(&mut self, new_session_epoch: u64, new_dimension_epoch: u64) {
        self.session_epoch = new_session_epoch;
        self.dimension_epoch = new_dimension_epoch;
        self.last_sequence = 0;
        self.desynced = false;
        self.replay.clear();
    }

    pub fn is_desynced(&self) -> bool {
        self.desynced
    }

    pub fn last_sequence(&self) -> u64 {
        self.last_sequence
    }

    pub fn session_epoch(&self) -> u64 {
        self.session_epoch
    }

    pub fn dimension_epoch(&self) -> u64 {
        self.dimension_epoch
    }

    pub fn replay_len(&self) -> usize {
        self.replay.len()
    }

    pub fn replay_floor(&self) -> Option<u64> {
        self.replay.floor()
    }

    /// 窗口内某序号的已记录 fingerprint（duplicate ack 回显用）。
    pub fn replay_fingerprint(&self, sequence: u64) -> Option<u64> {
        self.replay.lookup(sequence)
    }
}
