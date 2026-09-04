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
