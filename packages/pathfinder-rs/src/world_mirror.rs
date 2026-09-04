//! world_mirror.rs —— P5-C：Rust WorldMirror 核心（纯数据层，不接运行时）。
//!
//! 边界纪律（加固提示词 Phase 5）：
//!  - Rust 零 Minecraft 知识：不硬编码方块名、不假设 stateId=0=air——
//!    分类表由 TS 握手传入（registry/stateId → class bitmask）。
//!  - 事务式导入：CHUNK_BEGIN → SECTION_DATA* → CHUNK_COMMIT；COMMIT 前
//!    对查询/snapshot 不可见。
//!  - block update 在导入期间排队，COMMIT 后按 sequence 应用。
//!  - 四态区分（来自 prismarine-chunk 1.40 实测语义——JS 层
//!    getBlockStateId 对缺失 section 返回 0，镜像端必须由提取器显式声明，
//!    永不把缺席自动当 UNKNOWN/AIR）：
//!      Empty      —— 服务端显式发送的全气 section（已加载已导入）
//!      Data       —— 有方块数据的 section（已加载已导入）
//!      NotPresent —— chunk 列内该 section 槽位缺席（未导入完成的一种）
//!      chunk 整体未加载 / 已卸载
//!      Desynced   —— 溢出/重建超时后标记，fail-closed
//!  - SectionKey 用**绝对 sectionY**（1.18+ minY 可为负；提取器（P5-D，
//!    TS 侧）负责 (blockY - minY) >> 4 的换算并传绝对值）。
//!  - 内存：避免稠密 u32 stateId（4096×4B/section 的膨胀源）。每 section
//!    存 palette 索引 u16（8KB/section）+ 每 chunk 一张去重 palette。

use std::collections::HashMap;
use std::sync::Arc;

/// 类别 bitmask（位定义由 TS 侧约定；Rust 只做位运算，不解释语义）。
pub type BlockClassMask = u32;
/// UNKNOWN 类别位（握手表项全 0 视为未分类=UNKNOWN，非 AIR）。
pub const CLASS_UNKNOWN_BIT: BlockClassMask = 1 << 31;

pub type ChunkKey = (i32, i32); // (chunkX, chunkZ)——维度内
pub type SectionKey = (i32, i32, i32); // (chunkX, 绝对 sectionY, chunkZ)

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SectionStatus {
    /// 服务端显式发送的全气 section（已加载已导入；≠未知）。
    Empty,
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

/// section 级提交内容（导入事务的数据载荷）。
pub struct SectionPayload {
    pub section_y: i32,
    pub status: SectionStatus,
    /// Data：长度 4096 的 palette 索引（由 TS 提取器把 stateId 换算好）。
    pub palette_indices: Box<[u16]>,
    /// 本 section 引用的 palette 条目数（用于事务提交时合并 palette）。
    pub palette_entries: Vec<BlockClassMask>,
}

#[derive(Clone)]
pub struct ChunkState {
    pub sections: HashMap<i32, Section>,
    pub revision: u64,
    pub committed: bool,
}

/// 镜像消息（P5-C 核心；P5-D 的 worker 序列化层在此基础上包装）。
pub enum MirrorMessage {
    WorldReset {
        session_epoch: u64,
        dimension_epoch: u64,
        sequence: u64,
    },
    RegistryTable {
        sequence: u64,
        /// stateId → class mask；握手全表（索引即 stateId）。
        masks: Vec<BlockClassMask>,
    },
    ChunkBegin {
        session_epoch: u64,
        dimension_epoch: u64,
        chunk: ChunkKey,
        sequence: u64,
    },
    ChunkSectionData {
        chunk: ChunkKey,
        sequence: u64,
        payload: SectionPayload,
    },
    ChunkCommit {
        chunk: ChunkKey,
        sequence: u64,
    },
    ChunkUnload {
        chunk: ChunkKey,
        sequence: u64,
    },
    BlockUpdate {
        position: (i32, i32, i32),
        /// 新 stateId（经 registry 表换 class；表外 → UNKNOWN 位）。
        state_id: u32,
        sequence: u64,
    },
    /// 诊断：把某 chunk 标记 Desynced（溢出/重建超时）。
    MarkDesynced {
        chunk: ChunkKey,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub enum MirrorError {
    StaleSessionEpoch { expected: u64, got: u64 },
    StaleDimensionEpoch { expected: u64, got: u64 },
    StaleSequence { chunk: ChunkKey, applied: u64, got: u64 },
    UnknownChunk { chunk: ChunkKey },
    SectionWithoutBegin { chunk: ChunkKey },
    CommitWithoutBegin { chunk: ChunkKey },
    InvalidSectionLength { chunk: ChunkKey, section_y: i32, len: usize },
    RegistryMissing,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ApplyOutcome {
    Applied,
    /// 同 sequence 重放（幂等不重复索引/不推进 generation）。
    DuplicateReplay,
    /// 旧 sequence/迟到更新被拒。
    RejectedStale,
    /// 排队等待所属 chunk 的 COMMIT。
    QueuedUntilCommit,
}

struct PendingImport {
    session_epoch: u64,
    dimension_epoch: u64,
    begin_sequence: u64,
    sections: HashMap<i32, SectionPayload>,
}

/// 只读快照句柄（P5-C：不接 A*；generation 固定的 COW 视图）。
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
                SectionStatus::Empty => CellQuery::Mask(0),
                SectionStatus::NotPresent => CellQuery::SectionNotPresent,
                SectionStatus::Data => {
                    let local = section_local_index(x, y, z);
                    let palette_index = section.palette_indices[local] as usize;
                    let mask = self.registry.get(palette_index).copied().unwrap_or(CLASS_UNKNOWN_BIT);
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
    /// 已提交 chunk（chunk 载荷 Arc：snapshot 克隆 map 时共享，不拷数据）。
    chunks: HashMap<ChunkKey, Arc<ChunkState>>,
    pending_imports: HashMap<ChunkKey, PendingImport>,
    /// 导入期间到达的 block update（COMMIT 后按 sequence 应用）。
    queued_updates: Vec<((i32, i32, i32), u32, u64)>,
    last_sequence: u64,
    generation: u64,
}

impl WorldMirror {
    pub fn new(session_epoch: u64, dimension_epoch: u64) -> Self {
        WorldMirror {
            session_epoch,
            dimension_epoch,
            registry: Arc::new(Vec::new()),
            chunks: HashMap::new(),
            pending_imports: HashMap::new(),
            queued_updates: Vec::new(),
            last_sequence: 0,
            generation: 0,
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn loaded_chunks(&self) -> usize {
        self.chunks.len()
    }

    pub fn memory_stats(&self) -> MirrorMemoryStats {
        SnapshotHandle {
            generation: self.generation,
            session_epoch: self.session_epoch,
            dimension_epoch: self.dimension_epoch,
            chunks: Arc::new(self.chunks.clone()),
            registry: Arc::clone(&self.registry),
        }
        .memory_stats()
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

    /// 写访问：直接改 owned map——已发 snapshot 持有克隆 map + 共享 chunk Arc，
    /// 本侧变更对旧快照不可见（generation 语义由句柄携带）；chunk 级
    /// COW 用 Arc::make_mut 惰性拷贝。
    fn chunks_mut(&mut self) -> &mut HashMap<ChunkKey, Arc<ChunkState>> {
        &mut self.chunks
    }

    pub fn apply(&mut self, message: MirrorMessage) -> Result<ApplyOutcome, MirrorError> {
        match message {
            MirrorMessage::WorldReset { session_epoch, dimension_epoch, sequence } => {
                if session_epoch < self.session_epoch {
                    return Err(MirrorError::StaleSessionEpoch {
                        expected: self.session_epoch,
                        got: session_epoch,
                    });
                }
                if sequence <= self.last_sequence && self.last_sequence > 0 {
                    return Ok(ApplyOutcome::RejectedStale);
                }
                self.session_epoch = session_epoch;
                self.dimension_epoch = dimension_epoch;
                self.pending_imports.clear();
                self.queued_updates.clear();
                self.chunks = HashMap::new();
                self.last_sequence = sequence;
                self.generation += 1;
                Ok(ApplyOutcome::Applied)
            }
            MirrorMessage::RegistryTable { sequence, masks } => {
                if sequence <= self.last_sequence && self.last_sequence > 0 {
                    return Ok(ApplyOutcome::RejectedStale);
                }
                self.registry = Arc::new(masks);
                self.last_sequence = sequence;
                self.generation += 1;
                Ok(ApplyOutcome::Applied)
            }
            MirrorMessage::ChunkBegin { session_epoch, dimension_epoch, chunk, sequence } => {
                if session_epoch != self.session_epoch {
                    return Err(MirrorError::StaleSessionEpoch {
                        expected: self.session_epoch,
                        got: session_epoch,
                    });
                }
                if dimension_epoch != self.dimension_epoch {
                    return Err(MirrorError::StaleDimensionEpoch {
                        expected: self.dimension_epoch,
                        got: dimension_epoch,
                    });
                }
                if sequence <= self.last_sequence && self.last_sequence > 0 {
                    return Ok(ApplyOutcome::RejectedStale);
                }
                if let Some(existing) = self.pending_imports.get(&chunk) {
                    if existing.begin_sequence == sequence {
                        return Ok(ApplyOutcome::DuplicateReplay);
                    }
                }
                self.pending_imports.insert(
                    chunk,
                    PendingImport {
                        session_epoch,
                        dimension_epoch,
                        begin_sequence: sequence,
                        sections: HashMap::new(),
                    },
                );
                self.last_sequence = sequence;
                Ok(ApplyOutcome::Applied)
            }
            MirrorMessage::ChunkSectionData { chunk, sequence, payload } => {
                if sequence <= self.last_sequence && self.last_sequence > 0 {
                    return Ok(ApplyOutcome::RejectedStale);
                }
                let import = self
                    .pending_imports
                    .get_mut(&chunk)
                    .ok_or(MirrorError::SectionWithoutBegin { chunk })?;
                if payload.status == SectionStatus::Data && payload.palette_indices.len() != 4096 {
                    return Err(MirrorError::InvalidSectionLength {
                        chunk,
                        section_y: payload.section_y,
                        len: payload.palette_indices.len(),
                    });
                }
                import.sections.insert(payload.section_y, payload);
                self.last_sequence = sequence;
                Ok(ApplyOutcome::Applied)
            }
            MirrorMessage::ChunkCommit { chunk, sequence } => {
                if sequence <= self.last_sequence && self.last_sequence > 0 {
                    return Ok(ApplyOutcome::RejectedStale);
                }
                let import = self
                    .pending_imports
                    .remove(&chunk)
                    .ok_or(MirrorError::CommitWithoutBegin { chunk })?;
                // 合并 palette：本 chunk 的去重表追加进全局 registry 视图。
                let mut registry: Vec<BlockClassMask> = (*self.registry).clone();
                let mut sections = HashMap::new();
                for (section_y, payload) in import.sections {
                    let palette_indices = match payload.status {
                        SectionStatus::Data => {
                            let mut remapped = Vec::with_capacity(payload.palette_indices.len());
                            for &index in payload.palette_indices.iter() {
                                let mask = payload
                                    .palette_entries
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
                            remapped.into_boxed_slice()
                        }
                        _ => Box::from([]),
                    };
                    sections.insert(
                        section_y,
                        Section {
                            status: payload.status,
                            palette_indices,
                            revision: sequence,
                        },
                    );
                }
                self.registry = Arc::new(registry);
                let chunks = self.chunks_mut();
                chunks.insert(
                    chunk,
                    Arc::new(ChunkState {
                        sections,
                        revision: sequence,
                        committed: true,
                    }),
                );
                self.last_sequence = sequence;
                self.generation += 1;
                // 应用排队 update（按 sequence 升序；过期丢弃计数）。
                let mut applied_from_queue = 0;
                let queued: Vec<_> = std::mem::take(&mut self.queued_updates);
                let mut remaining = Vec::new();
                for entry in queued {
                    let (position, state_id, update_sequence) = entry;
                    let update_chunk = (position.0 >> 4, position.2 >> 4);
                    if update_chunk == chunk {
                        if update_sequence > sequence {
                            remaining.push(entry);
                        } else {
                            self.apply_block_update_internal(position, state_id, update_sequence);
                            applied_from_queue += 1;
                        }
                    } else {
                        remaining.push(entry);
                    }
                }
                self.queued_updates = remaining;
                let _ = applied_from_queue;
                Ok(ApplyOutcome::Applied)
            }
            MirrorMessage::ChunkUnload { chunk, sequence } => {
                if sequence <= self.last_sequence && self.last_sequence > 0 {
                    return Ok(ApplyOutcome::RejectedStale);
                }
                let chunks = self.chunks_mut();
                if chunks.remove(&chunk).is_none() {
                    // 卸载未加载 chunk：幂等成功（不复活不报错）。
                    self.last_sequence = sequence;
                    return Ok(ApplyOutcome::DuplicateReplay);
                }
                // 淘汰更旧的排队 delta（unload 覆盖未处理 update）。
                self.queued_updates
                    .retain(|(position, _, _)| (position.0 >> 4, position.2 >> 4) != chunk);
                self.last_sequence = sequence;
                self.generation += 1;
                Ok(ApplyOutcome::Applied)
            }
            MirrorMessage::BlockUpdate { position, state_id, sequence } => {
                if sequence <= self.last_sequence && self.last_sequence > 0 {
                    return Ok(ApplyOutcome::RejectedStale);
                }
                let chunk = (position.0 >> 4, position.2 >> 4);
                if self.pending_imports.contains_key(&chunk) {
                    // 导入期间：排队（COMMIT 后按 sequence 应用）。
                    self.queued_updates.push((position, state_id, sequence));
                    return Ok(ApplyOutcome::QueuedUntilCommit);
                }
                if !self.chunks.contains_key(&chunk) {
                    // unload 后迟到更新：拒绝（不得复活 chunk）。
                    return Ok(ApplyOutcome::RejectedStale);
                }
                self.apply_block_update_internal(position, state_id, sequence);
                self.last_sequence = sequence;
                self.generation += 1;
                Ok(ApplyOutcome::Applied)
            }
            MirrorMessage::MarkDesynced { chunk } => {
                let chunks = self.chunks_mut();
                if let Some(state) = chunks.get_mut(&chunk) {
                    let mutable = Arc::make_mut(state);
                    for section in mutable.sections.values_mut() {
                        if section.status != SectionStatus::NotPresent {
                            section.status = SectionStatus::Desynced;
                        }
                    }
                    self.generation += 1;
                    Ok(ApplyOutcome::Applied)
                } else {
                    Err(MirrorError::UnknownChunk { chunk })
                }
            }
        }
    }

    fn apply_block_update_internal(&mut self, position: (i32, i32, i32), state_id: u32, sequence: u64) {
        let chunk = (position.0 >> 4, position.2 >> 4);
        let mask = self.registry.get(state_id as usize).copied().unwrap_or(CLASS_UNKNOWN_BIT);
        // 先做 palette 去重（借用结束后再动 chunks，避免交叉借用）。
        let mut registry_vec: Vec<BlockClassMask> = (*self.registry).clone();
        let index = match registry_vec.iter().position(|&m| m == mask) {
            Some(existing) => existing,
            None => {
                registry_vec.push(mask);
                registry_vec.len() - 1
            }
        };
        let chunks = self.chunks_mut();
        let Some(state) = chunks.get_mut(&chunk) else { return };
        let mutable = Arc::make_mut(state);
        let section_y = position.1 >> 4;
        let Some(section) = mutable.sections.get_mut(&section_y) else { return };
        if section.status != SectionStatus::Data {
            // 非 Data section 上的 update = 提取器漏导入：fail-closed 保持
            // 原状（P5-D shadow oracle 会对出该差异）。
            return;
        }
        let local = section_local_index(position.0, position.1, position.2);
        section.palette_indices[local] = index as u16;
        section.revision = sequence;
        mutable.revision = sequence;
        drop(mutable);
        self.registry = Arc::new(registry_vec);
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
