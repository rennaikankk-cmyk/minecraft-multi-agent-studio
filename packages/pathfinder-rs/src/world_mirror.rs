//! world_mirror.rs —— P5-C/D2b：Rust WorldMirror 核心（纯数据层 + 会话管线）。
//!
//! D2b 迁移（P5-D2 指令 §10-§13）：
//!  - 业务消息 = `world_mirror_protocol::MirrorMessage`（Envelope 承载
//!    epoch/transportSequence；本层不再自带传输字段）。
//!  - Registry 握手屏障：RegistryTable 先行（revision+全表）；READY 前
//!    收到任何 chunk/update = 协议顺序错误 → Desynced + ResetRequired
//!    （数据已丢，不能普通 SemanticRejected 后继续）。已 READY 后换表
//!    （不同 revision 或同 revision 不同表）也 ResetRequired——已导入
//!    section 的 palette 索引引用全局表位置，换表会腐蚀既有索引；换表
//!    必须走 Reset→重新握手。
//!  - Empty section 携带显式 fillStateId，经 RegistryTable 分类（表外 →
//!    UNKNOWN 位）——不硬编码 stateId 0=空气。NotPresent 只描述存储
//!    形态，查询返回 SectionNotPresent（≠AIR≠UNKNOWN）。
//!  - BlockUpdateBatch：绝对最终 stateId + source 序号范围（允许因同
//!    坐标合并不连续——transport gate 只管 transportSequence 连续性）。
//!    导入期间的 update 按 (source_last_sequence, 批内序) 排队，COMMIT
//!    后按 source 顺序重放（最终值幂等：同格重复写无副作用）。
//!  - WorldReset = 控制面消息（`MirrorControl::WorldReset`），epoch 必须
//!    严格前进；原子清空 chunks/pending/queued/desynced/registry READY，
//!    transportSequence 重基（下一条必须为 1）。迟到/同 epoch Reset 拒绝。
//!  - 语义拒绝（chunk 不存在/无开放导入等）消费传输槽——槽位已在
//!    admission 记录（§9），下一条合法消息不会被误判为缺口。
//!
//! P5-C 保留不变的事实：
//!  - Rust 零 Minecraft 知识（分类表由 TS 握手传入；表外 → UNKNOWN 位）。
//!  - 事务式导入：CHUNK_BEGIN → SECTION_DATA* → CHUNK_COMMIT；COMMIT 前
//!    对查询/snapshot 不可见。
//!  - 四态查询 Data/Empty/SectionNotPresent/ChunkNotLoaded + Desynced
//!    覆盖态（调用方必须先检查覆盖态再解释四种状态）。
//!  - SectionKey 用绝对 sectionY（1.18+ minY 可为负）。
//!  - palette u16 索引/section + 每 chunk 去重（内存策略：4096×4B 稠密
//!    stateId 的膨胀源→u16 索引 8KB/section + 全局去重表）。
//!  - epoch 权威在 TS session supervisor；Rust 只校验回显。
//!  - SnapshotHandle Arc chunk 共享（generation 固定 COW 视图）。

use std::collections::HashMap;
use std::sync::Arc;

use crate::world_mirror_protocol::{
    payload_fingerprint, AckReason, AckStatus, AdmissionGate, AdmissionVerdict, MirrorAck,
    MirrorControl, MirrorEnvelope, MirrorMessage, SectionPayload, MIRROR_PROTOCOL_VERSION,
};

/// 类别 bitmask（位定义由 TS 侧约定；Rust 只做位运算，不解释语义）。
pub type BlockClassMask = u32;
/// UNKNOWN 类别位（握手表项全 0 视为未分类=UNKNOWN，非 AIR）。
pub const CLASS_UNKNOWN_BIT: BlockClassMask = 1 << 31;

pub type ChunkKey = (i32, i32); // (chunkX, chunkZ)——维度内
pub type SectionKey = (i32, i32, i32); // (chunkX, 绝对 sectionY, chunkZ)

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SectionStatus {
    /// 显式空 section：fill_state_id 已经 RegistryTable 分类的 mask。
    Empty { fill_mask: BlockClassMask },
    /// 有方块数据（已加载已导入）。
    Data,
    /// chunk 列内该槽位缺席（prismarine sections[i] 无对象）。
    NotPresent,
    /// 溢出/重建超时标记（fail-closed）。
    Desynced,
}

/// 单 section 存储：palette 索引（u16）而非 stateId——内存策略见模块头。
#[derive(Clone)]
pub struct Section {
    pub status: SectionStatus,
    /// Data 状态下长度 4096 的 palette 索引表；其余状态为空。
    pub palette_indices: Box<[u16]>,
    pub revision: u64,
}

#[derive(Clone)]
pub struct ChunkState {
    pub sections: HashMap<i32, Section>,
    pub revision: u64,
    pub committed: bool,
}

/// 业务 apply 结果（传输层 admission 结果由 MirrorSession 单独映射）。
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum ApplyOutcome {
    Applied,
    /// RegistryTable 安装成功（握手就绪，revision/表 fingerprint 随 ack 回）。
    RegistryReady,
    /// 导入事务期间到达：已按 source 序号排队，COMMIT 后重放。
    QueuedUntilCommit,
    /// 业务前置条件不满足（无开放导入/chunk 不存在等）——传输槽已消费。
    SemanticRejected {
        reason: AckReason,
    },
    /// 协议顺序/一致性错误（registry 未就绪、表漂移）——已置 Desynced，
    /// 调用方必须走权威 Reset→重新握手→truth 重建。
    ResetRequired {
        reason: AckReason,
    },
}

/// 导入期间到达的 update（COMMIT 后按 source 顺序重放；order_key =
/// (source_last_sequence, 批内序) 保证确定性排序）。
#[derive(Clone, Copy, Debug)]
struct QueuedUpdate {
    order_key: (u64, u32),
    position: (i32, i32, i32),
    state_id: u32,
}

struct PendingImport {
    /// sectionY → 协议载荷（Empty 的 fill 分类与 Data 的 palette 合并
    /// 都在 COMMIT 时做——那时 registry 一定已就绪）。
    sections: HashMap<i32, SectionPayload>,
}

/// 只读快照句柄（generation 固定的 COW 视图；P5-C 语义不变）。
pub struct SnapshotHandle {
    pub generation: u64,
    pub session_epoch: u64,
    pub dimension_epoch: u64,
    chunks: Arc<HashMap<ChunkKey, Arc<ChunkState>>>,
    registry: Arc<Vec<BlockClassMask>>,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum CellQuery {
    /// 已导入的类别掩码。
    Mask(BlockClassMask),
    /// chunk 已加载但该 section 槽缺席（非 AIR 非未知方块）。
    SectionNotPresent,
    /// chunk 未加载/未导入完成。
    ChunkNotLoaded,
    /// Desynced（fail-closed）。
    Desynced,
}

impl SnapshotHandle {
    /// 绝对坐标查询（y 为方块绝对坐标；内部按 section 高度换算）。
    pub fn query(&self, x: i32, y: i32, z: i32) -> CellQuery {
        let chunk = (x >> 4, z >> 4);
        let state = match self.chunks.get(&chunk) {
            None => return CellQuery::ChunkNotLoaded,
            Some(state) => state,
        };
        let section_y = y >> 4;
        match state.sections.get(&section_y) {
            None => CellQuery::SectionNotPresent,
            Some(section) => match section.status {
                SectionStatus::Desynced => CellQuery::Desynced,
                // 显式空 section：fill_state_id 经表分类的 mask（非硬编码 0）。
                SectionStatus::Empty { fill_mask } => CellQuery::Mask(fill_mask),
                SectionStatus::NotPresent => CellQuery::SectionNotPresent,
                SectionStatus::Data => {
                    let local = section_local_index(x, y, z);
                    let palette_index = section.palette_indices[local] as usize;
                    let mask = self
                        .registry
                        .get(palette_index)
                        .copied()
                        .unwrap_or(CLASS_UNKNOWN_BIT);
                    CellQuery::Mask(mask)
                }
            },
        }
    }

    pub fn memory_stats(&self) -> MirrorMemoryStats {
        let mut sections_data = 0usize;
        let mut sections_other = 0usize;
        for state in self.chunks.values() {
            for section in state.sections.values() {
                if section.status == SectionStatus::Data {
                    sections_data += 1;
                } else {
                    sections_other += 1;
                }
            }
        }
        MirrorMemoryStats {
            chunks_loaded: self.chunks.len(),
            sections_data,
            sections_other,
            palette_entries: self.registry.len(),
            // u16×4096/section + HashMap/Box 元开销（保守 ~100B/项）
            approx_bytes: sections_data * 4096 * 2
                + sections_other * 100
                + self.chunks.len() * 200
                + self.registry.len() * 4,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MirrorMemoryStats {
    pub chunks_loaded: usize,
    pub sections_data: usize,
    pub sections_other: usize,
    pub palette_entries: usize,
    pub approx_bytes: usize,
}

pub struct WorldMirror {
    session_epoch: u64,
    dimension_epoch: u64,
    registry: Arc<Vec<BlockClassMask>>,
    registry_revision: u64,
    registry_ready: bool,
    /// 已提交 chunk（chunk 载荷 Arc：snapshot 克隆 map 时共享，不拷数据）。
    chunks: HashMap<ChunkKey, Arc<ChunkState>>,
    pending_imports: HashMap<ChunkKey, PendingImport>,
    /// 导入期间到达的 block update（COMMIT 后按 source 顺序应用）。
    queued_updates: Vec<QueuedUpdate>,
    /// DESYNCED 覆盖态（缺口/冲突/协议顺序错误后置位；Reset 前查询 fail-closed）。
    desynced: bool,
    generation: u64,
    /// 最近一次 batch 中被跳过的 update 数（目标 chunk 未加载——可观测）。
    last_batch_skipped: u64,
    skipped_updates_total: u64,
}

impl WorldMirror {
    pub fn new(session_epoch: u64, dimension_epoch: u64) -> Self {
        WorldMirror {
            session_epoch,
            dimension_epoch,
            registry: Arc::new(Vec::new()),
            registry_revision: 0,
            registry_ready: false,
            chunks: HashMap::new(),
            pending_imports: HashMap::new(),
            queued_updates: Vec::new(),
            desynced: false,
            generation: 0,
            last_batch_skipped: 0,
            skipped_updates_total: 0,
        }
    }

    pub fn session_epoch(&self) -> u64 {
        self.session_epoch
    }

    pub fn dimension_epoch(&self) -> u64 {
        self.dimension_epoch
    }

    pub fn is_desynced(&self) -> bool {
        self.desynced
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn loaded_chunks(&self) -> usize {
        self.chunks.len()
    }

    pub fn registry_ready(&self) -> bool {
        self.registry_ready
    }

    pub fn registry_revision(&self) -> u64 {
        self.registry_revision
    }

    pub fn last_batch_skipped(&self) -> u64 {
        self.last_batch_skipped
    }

    pub fn skipped_updates_total(&self) -> u64 {
        self.skipped_updates_total
    }

    pub fn pending_import_count(&self) -> usize {
        self.pending_imports.len()
    }

    pub fn queued_update_count(&self) -> usize {
        self.queued_updates.len()
    }

    pub fn memory_stats(&self) -> MirrorMemoryStats {
        self.snapshot_handle().memory_stats()
    }

    /// 只读快照（generation 固定；后续变更不影响已发句柄）。
    pub fn snapshot_handle(&self) -> SnapshotHandle {
        SnapshotHandle {
            generation: self.generation,
            session_epoch: self.session_epoch,
            dimension_epoch: self.dimension_epoch,
            chunks: Arc::new(self.chunks.clone()),
            registry: Arc::clone(&self.registry),
        }
    }

    /// Rust 内部诊断（非传输消息）：把某 chunk 标记 Desynced。
    pub fn mark_chunk_desynced(&mut self, chunk: ChunkKey) -> Result<(), AckReason> {
        let Some(state) = self.chunks.get_mut(&chunk) else {
            return Err(AckReason::ChunkNotLoaded);
        };
        let mutable = Arc::make_mut(state);
        for section in mutable.sections.values_mut() {
            if section.status != SectionStatus::NotPresent {
                section.status = SectionStatus::Desynced;
            }
        }
        self.generation += 1;
        Ok(())
    }

    /// 权威 Reset 的镜像侧执行（epoch 前进性由 MirrorSession 校验）：
    /// 原子清空全部状态并清除 registry READY——之后必须重新握手。
    pub fn reset(&mut self, new_session_epoch: u64, new_dimension_epoch: u64) {
        self.session_epoch = new_session_epoch;
        self.dimension_epoch = new_dimension_epoch;
        self.registry = Arc::new(Vec::new());
        self.registry_revision = 0;
        self.registry_ready = false;
        self.chunks.clear();
        self.pending_imports.clear();
        self.queued_updates.clear();
        self.desynced = false;
        self.last_batch_skipped = 0;
        self.generation += 1;
    }

    /// 业务 apply（消息所有权移入——section 载荷零额外复制）。
    /// transport_sequence 用于 chunk revision 标记；槽位消费在 admission。
    pub fn apply_message(
        &mut self,
        message: MirrorMessage,
        transport_sequence: u64,
    ) -> ApplyOutcome {
        match message {
            MirrorMessage::RegistryTable {
                revision, masks, ..
            } => {
                if !self.registry_ready {
                    self.registry = Arc::new(masks);
                    self.registry_revision = revision;
                    self.registry_ready = true;
                    self.generation += 1;
                    return ApplyOutcome::RegistryReady;
                }
                // 已就绪：仅幂等接受同 revision 同表重发。
                if revision == self.registry_revision && *self.registry == masks {
                    return ApplyOutcome::RegistryReady;
                }
                // 换表（不同 revision / 同 revision 不同表）腐蚀既有 palette
                // 索引——fail-close，要求 Reset 后重新握手。
                self.desynced = true;
                ApplyOutcome::ResetRequired {
                    reason: AckReason::RegistryMismatch,
                }
            }
            MirrorMessage::ChunkBegin { chunk } => {
                if let Some(outcome) = self.require_registry() {
                    return outcome;
                }
                // 重复 BEGIN（新传输序号的同 chunk）：TS 重启该 chunk 导入，
                // 覆盖旧事务（旧 pending 丢弃，迟到 COMMIT 不复活旧内容）。
                self.pending_imports.insert(
                    chunk,
                    PendingImport {
                        sections: HashMap::new(),
                    },
                );
                ApplyOutcome::Applied
            }
            MirrorMessage::SectionData { chunk, payload } => {
                if let Some(outcome) = self.require_registry() {
                    return outcome;
                }
                let section_y = payload.section_y();
                let Some(import) = self.pending_imports.get_mut(&chunk) else {
                    return ApplyOutcome::SemanticRejected {
                        reason: AckReason::NoOpenImport,
                    };
                };
                import.sections.insert(section_y, payload);
                ApplyOutcome::Applied
            }
            MirrorMessage::ChunkCommit { chunk } => {
                if let Some(outcome) = self.require_registry() {
                    return outcome;
                }
                let Some(import) = self.pending_imports.remove(&chunk) else {
                    return ApplyOutcome::SemanticRejected {
                        reason: AckReason::NoOpenImport,
                    };
                };
                let mut registry: Vec<BlockClassMask> = (*self.registry).clone();
                let mut sections = HashMap::new();
                for (section_y, payload) in import.sections {
                    match payload {
                        SectionPayload::Data {
                            palette_indices,
                            palette_entries,
                            ..
                        } => {
                            let mut remapped = Vec::with_capacity(palette_indices.len());
                            for &index in palette_indices.iter() {
                                let mask = palette_entries
                                    .get(index as usize)
                                    .copied()
                                    .unwrap_or(CLASS_UNKNOWN_BIT);
                                // 去重插入全局表。
                                if let Some(existing) = registry.iter().position(|&m| m == mask) {
                                    remapped.push(existing as u16);
                                } else {
                                    registry.push(mask);
                                    remapped.push((registry.len() - 1) as u16);
                                }
                            }
                            sections.insert(
                                section_y,
                                Section {
                                    status: SectionStatus::Data,
                                    palette_indices: remapped.into_boxed_slice(),
                                    revision: transport_sequence,
                                },
                            );
                        }
                        SectionPayload::Empty { fill_state_id, .. } => {
                            // 显式空 section：fill 经表分类（表外 → UNKNOWN）。
                            let fill_mask = self
                                .registry
                                .get(fill_state_id as usize)
                                .copied()
                                .unwrap_or(CLASS_UNKNOWN_BIT);
                            sections.insert(
                                section_y,
                                Section {
                                    status: SectionStatus::Empty { fill_mask },
                                    palette_indices: Box::from([]),
                                    revision: transport_sequence,
                                },
                            );
                        }
                        SectionPayload::NotPresent { .. } => {
                            // 槽位缺席不落 section：查询自然返回 SectionNotPresent。
                        }
                    }
                }
                self.registry = Arc::new(registry);
                self.chunks.insert(
                    chunk,
                    Arc::new(ChunkState {
                        sections,
                        revision: transport_sequence,
                        committed: true,
                    }),
                );
                // 重放排队 update：按 source 顺序（order_key）应用——更新
                // 携带绝对最终 stateId，同格重复应用最终值幂等。
                let mut remaining = Vec::new();
                let mut replay = Vec::new();
                for queued in std::mem::take(&mut self.queued_updates) {
                    if (queued.position.0 >> 4, queued.position.2 >> 4) == chunk {
                        replay.push(queued);
                    } else {
                        remaining.push(queued);
                    }
                }
                self.queued_updates = remaining;
                replay.sort_by_key(|q| q.order_key);
                for queued in replay {
                    self.apply_block_update_internal(
                        queued.position,
                        queued.state_id,
                        queued.order_key.0,
                    );
                }
                self.generation += 1;
                ApplyOutcome::Applied
            }
            MirrorMessage::ChunkUnload { chunk } => {
                if let Some(outcome) = self.require_registry() {
                    return outcome;
                }
                let was_loaded = self.chunks.remove(&chunk).is_some();
                // 淘汰更旧的排队 delta + 丢弃未完成导入：迟到 COMMIT 不得
                // 复活已卸载 chunk（P5-C 属性测试 seed=2 实锤语义）。
                self.queued_updates
                    .retain(|q| (q.position.0 >> 4, q.position.2 >> 4) != chunk);
                self.pending_imports.remove(&chunk);
                if was_loaded {
                    self.generation += 1;
                }
                // 卸载未加载 chunk：幂等成功（不复活不报错）。
                ApplyOutcome::Applied
            }
            MirrorMessage::BlockUpdateBatch {
                source_last_sequence,
                updates,
                ..
            } => {
                if let Some(outcome) = self.require_registry() {
                    return outcome;
                }
                let mut queued_any = false;
                let mut skipped = 0u64;
                for (index, entry) in updates.into_iter().enumerate() {
                    let chunk = (entry.position.0 >> 4, entry.position.2 >> 4);
                    if self.pending_imports.contains_key(&chunk) {
                        // 导入期间：按 source 序号排队（COMMIT 后重放）。
                        self.queued_updates.push(QueuedUpdate {
                            order_key: (source_last_sequence, index as u32),
                            position: entry.position,
                            state_id: entry.state_id,
                        });
                        queued_any = true;
                    } else if self.chunks.contains_key(&chunk) {
                        self.apply_block_update_internal(
                            entry.position,
                            entry.state_id,
                            source_last_sequence,
                        );
                    } else {
                        // unload 后迟到更新：跳过（不得复活 chunk）——计数可观测。
                        skipped += 1;
                    }
                }
                self.last_batch_skipped = skipped;
                self.skipped_updates_total += skipped;
                if queued_any {
                    ApplyOutcome::QueuedUntilCommit
                } else {
                    ApplyOutcome::Applied
                }
            }
        }
    }

    /// registry 屏障：READY 前一切 chunk/update = 协议顺序错误（数据已
    /// 丢）——置 Desynced 并要求 Reset 重建（§10）。
    fn require_registry(&mut self) -> Option<ApplyOutcome> {
        if self.registry_ready {
            return None;
        }
        self.desynced = true;
        Some(ApplyOutcome::ResetRequired {
            reason: AckReason::RegistryNotReady,
        })
    }

    fn apply_block_update_internal(
        &mut self,
        position: (i32, i32, i32),
        state_id: u32,
        source_sequence: u64,
    ) {
        let chunk = (position.0 >> 4, position.2 >> 4);
        let mask = self
            .registry
            .get(state_id as usize)
            .copied()
            .unwrap_or(CLASS_UNKNOWN_BIT);
        // 先做 palette 去重（借用结束后再动 chunks，避免交叉借用）。
        let mut registry_vec: Vec<BlockClassMask> = (*self.registry).clone();
        let index = match registry_vec.iter().position(|&m| m == mask) {
            Some(existing) => existing,
            None => {
                registry_vec.push(mask);
                registry_vec.len() - 1
            }
        };
        let Some(state) = self.chunks.get_mut(&chunk) else {
            return;
        };
        let mutable = Arc::make_mut(state);
        let section_y = position.1 >> 4;
        let Some(section) = mutable.sections.get_mut(&section_y) else {
            return;
        };
        if !matches!(section.status, SectionStatus::Data) {
            // 非 Data section 上的 update = 提取器漏导入：fail-closed 保持
            // 原状（shadow oracle 会对出该差异）。
            self.registry = Arc::new(registry_vec);
            return;
        }
        let local = section_local_index(position.0, position.1, position.2);
        section.palette_indices[local] = index as u16;
        section.revision = section.revision.max(source_sequence);
        mutable.revision = mutable.revision.max(source_sequence);
        self.registry = Arc::new(registry_vec);
        self.generation += 1;
    }

    /// 会话级 Desynced（gap/conflict 与镜像覆盖态保持一致）。
    fn mark_session_desynced(&mut self) {
        self.desynced = true;
    }
}

/// 会话健康快照（HealthProbe/诊断）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MirrorHealth {
    pub desynced: bool,
    pub stopped: bool,
    pub loaded_chunks: usize,
    pub pending_imports: usize,
    pub queued_updates: usize,
    pub registry_ready: bool,
    pub registry_revision: u64,
    pub last_transport_sequence: u64,
    pub replay_window_len: usize,
    pub replay_window_floor: Option<u64>,
    pub mirror_generation: u64,
    pub skipped_updates_total: u64,
}

/// 完整同步管线：admission（协议外壳）+ WorldMirror（业务）→ 结构化 ACK。
/// Rust 侧唯一对外入口（napi 层包装；P5-D2c）。
pub struct MirrorSession {
    gate: AdmissionGate,
    mirror: WorldMirror,
    stopped: bool,
}

impl MirrorSession {
    pub fn new(session_epoch: u64, dimension_epoch: u64) -> Self {
        MirrorSession {
            gate: AdmissionGate::new(session_epoch, dimension_epoch),
            mirror: WorldMirror::new(session_epoch, dimension_epoch),
            stopped: false,
        }
    }

    pub fn with_replay_capacity(session_epoch: u64, dimension_epoch: u64, capacity: usize) -> Self {
        MirrorSession {
            gate: AdmissionGate::with_replay_capacity(session_epoch, dimension_epoch, capacity),
            mirror: WorldMirror::new(session_epoch, dimension_epoch),
            stopped: false,
        }
    }

    pub fn mirror(&self) -> &WorldMirror {
        &self.mirror
    }

    /// 内部诊断入口（MarkDesynced 不是传输消息，不经 admission）。
    pub fn mirror_mut(&mut self) -> &mut WorldMirror {
        &mut self.mirror
    }

    pub fn health(&self) -> MirrorHealth {
        MirrorHealth {
            desynced: self.mirror.is_desynced() || self.gate.is_desynced(),
            stopped: self.stopped,
            loaded_chunks: self.mirror.loaded_chunks(),
            pending_imports: self.mirror.pending_import_count(),
            queued_updates: self.mirror.queued_update_count(),
            registry_ready: self.mirror.registry_ready(),
            registry_revision: self.mirror.registry_revision(),
            last_transport_sequence: self.gate.last_sequence(),
            replay_window_len: self.gate.replay_len(),
            replay_window_floor: self.gate.replay_floor(),
            mirror_generation: self.mirror.generation(),
            skipped_updates_total: self.mirror.skipped_updates_total(),
        }
    }

    fn ack(&self, transport_sequence: u64, status: AckStatus) -> MirrorAck {
        MirrorAck {
            protocol_version: MIRROR_PROTOCOL_VERSION,
            session_epoch: self.mirror.session_epoch(),
            dimension_epoch: self.mirror.dimension_epoch(),
            transport_sequence,
            status,
            mirror_generation: self.mirror.generation(),
            registry_revision: None,
            chunk_revision: None,
            reason: None,
            payload_fingerprint: None,
            skipped_updates: None,
        }
    }

    /// 普通数据消息入口（admission → apply → ACK；§7 九步）。
    pub fn submit_envelope(&mut self, envelope: MirrorEnvelope) -> MirrorAck {
        if self.stopped {
            return self.ack(0, AckStatus::Stopping);
        }
        let sequence = envelope.transport_sequence;
        // 业务层已 Desynced（registry 屏障/表漂移）：一切数据消息 fail-close，
        // 恢复=权威 Reset（触发原因已在致因 ack 中报告）。
        if self.mirror.is_desynced() {
            return self.ack(sequence, AckStatus::ResetRequired);
        }
        let verdict = self.gate.admit(&envelope);
        match verdict {
            AdmissionVerdict::Admit => {
                let fingerprint = payload_fingerprint(&envelope.message);
                let outcome = self.mirror.apply_message(envelope.message, sequence);
                let mut ack = self.ack(sequence, AckStatus::Applied);
                ack.payload_fingerprint = Some(fingerprint);
                match outcome {
                    ApplyOutcome::Applied => {}
                    ApplyOutcome::RegistryReady => {
                        ack.status = AckStatus::RegistryReady;
                        ack.registry_revision = Some(self.mirror.registry_revision());
                    }
                    ApplyOutcome::QueuedUntilCommit => {
                        ack.status = AckStatus::QueuedUntilCommit;
                    }
                    ApplyOutcome::SemanticRejected { reason } => {
                        ack.status = AckStatus::SemanticRejected;
                        ack.reason = Some(reason);
                    }
                    ApplyOutcome::ResetRequired { reason } => {
                        ack.status = AckStatus::ResetRequired;
                        ack.reason = Some(reason);
                    }
                }
                ack.skipped_updates = Some(self.mirror.last_batch_skipped());
                ack
            }
            AdmissionVerdict::IgnoredDuplicate => {
                let mut ack = self.ack(sequence, AckStatus::IgnoredDuplicate);
                ack.payload_fingerprint = self.gate.replay_fingerprint(sequence);
                ack
            }
            AdmissionVerdict::IgnoredStale => self.ack(sequence, AckStatus::IgnoredStale),
            AdmissionVerdict::ProtocolConflict => {
                // 冲突置镜像 Desynced（查询侧 fail-close 与闸一致）。
                self.mirror.mark_session_desynced();
                self.ack(sequence, AckStatus::ProtocolConflict)
            }
            AdmissionVerdict::GapDesynced => {
                self.mirror.mark_session_desynced();
                self.ack(sequence, AckStatus::GapDesynced)
            }
            AdmissionVerdict::WrongEpoch => {
                let mut ack = self.ack(sequence, AckStatus::WrongEpoch);
                ack.reason = Some(AckReason::EpochNotAdvanced);
                ack
            }
            AdmissionVerdict::UnsupportedProtocol => {
                self.ack(sequence, AckStatus::UnsupportedProtocol)
            }
            AdmissionVerdict::MalformedEnvelope => self.ack(sequence, AckStatus::MalformedEnvelope),
            AdmissionVerdict::RejectedDesynced => {
                // Desynced 期间拒绝数据：恢复路径=权威 Reset。
                self.ack(sequence, AckStatus::ResetRequired)
            }
        }
    }

    /// 控制面入口（不走传输序号闸；Reset 权威在 TS supervisor）。
    pub fn submit_control(&mut self, control: &MirrorControl) -> MirrorAck {
        match control {
            MirrorControl::WorldReset {
                new_session_epoch,
                new_dimension_epoch,
                ..
            } => {
                if self.stopped {
                    return self.ack(0, AckStatus::Stopping);
                }
                let current_session = self.mirror.session_epoch();
                let current_dimension = self.mirror.dimension_epoch();
                // 权威 Reset 必须 epoch 严格前进（至少其一），且都不得倒退。
                let advanced = *new_session_epoch >= current_session
                    && *new_dimension_epoch >= current_dimension
                    && (*new_session_epoch > current_session
                        || *new_dimension_epoch > current_dimension);
                if !advanced {
                    let mut ack = self.ack(0, AckStatus::WrongEpoch);
                    ack.reason = Some(AckReason::EpochNotAdvanced);
                    return ack;
                }
                self.mirror.reset(*new_session_epoch, *new_dimension_epoch);
                self.gate
                    .apply_reset(*new_session_epoch, *new_dimension_epoch);
                self.ack(0, AckStatus::ResetApplied)
            }
            MirrorControl::Stop => {
                self.stopped = true;
                self.ack(0, AckStatus::Stopping)
            }
            MirrorControl::HealthProbe => {
                let mut ack = self.ack(0, AckStatus::Healthy);
                ack.registry_revision = if self.mirror.registry_ready() {
                    Some(self.mirror.registry_revision())
                } else {
                    None
                };
                ack
            }
        }
    }
}

/// prismarine 1.18+ section 内局部索引（y,z,x 各 4 位——与
/// getSectionBlockIndex 的 (y<<8)|(z<<4)|x 布局一致；提取器侧同源换算）。
fn section_local_index(x: i32, y: i32, z: i32) -> usize {
    let local_x = (x & 0x0F) as usize;
    let local_y = (y & 0x0F) as usize;
    let local_z = (z & 0x0F) as usize;
    (local_y << 8) | (local_z << 4) | local_x
}

#[cfg(test)]
mod tests {

    use super::*;
    use crate::world_mirror_protocol::*;
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
}
