//! mirror_napi.rs —— P5-D2c：WorldMirror 会话的 napi 导出（worker 内调用）。
//!
//! 边界纪律：
//!  - 每个镜像会话存活在单个 worker 线程的 thread_local 注册表里
//!    （handle → MirrorSession）；napi 函数只在加载本 addon 的线程上执行。
//!  - JS 侧信封为宽松 tagged object；本层做 fail-closed 解析——字段缺失/
//!    类型不符/长度不对一律返回 MalformedEnvelope ACK（不抛异常、不 panic），
//!    只有未知 handle 才是调用方编程错误（Err）。
//!  - epoch/序号在 JS 边界用 number（i64；实际值远低于 2^53）；
//!    fingerprint 是完整 u64，用十进制字符串保真（TS 侧 BigInt 核对）。
//!  - palette_indices/masks 以 Uint8Array（LE 字节流）传入：JS 平台字节序
//!    在所有受支持平台为 LE；Rust 按 LE 逐对解码。
//!  - 查询/snapshot 导出刻意不做（P5-D3：Pathfinder/SpatialIndex 尚未
//!    接 WorldMirror——D2 只建立同步通道与健康观测）。

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::world_mirror::{MirrorHealth, MirrorSession};
use crate::world_mirror_protocol::{
    AckReason, AckStatus, BlockUpdateEntry, MirrorControl, MirrorEnvelope, MirrorMessage,
    SectionPayload, WorldResetReason, MIRROR_PROTOCOL_VERSION, SECTION_CELLS,
};

thread_local! {
    static SESSIONS: RefCell<HashMap<u32, MirrorSession>> = RefCell::new(HashMap::new());
}

static NEXT_HANDLE: AtomicU32 = AtomicU32::new(1);

fn with_session<T>(handle: u32, f: impl FnOnce(&mut MirrorSession) -> T) -> Result<T> {
    SESSIONS
        .try_with(|sessions| {
            sessions.try_borrow_mut().map(|mut map| {
                map.get_mut(&handle).map(f).ok_or_else(|| {
                    Error::new(
                        Status::GenericFailure,
                        format!("unknown mirror handle {handle} (worker restarted or disposed)"),
                    )
                })
            })
        })
        .map_err(|_| Error::new(Status::GenericFailure, "mirror registry unavailable"))?
        .map_err(|_| Error::new(Status::GenericFailure, "mirror registry borrowed"))?
}

// ---------------------------------------------------------------------------
// JS 边界对象。
// ---------------------------------------------------------------------------

#[napi(object)]
pub struct MirrorAckJs {
    pub protocol_version: u32,
    pub session_epoch: i64,
    pub dimension_epoch: i64,
    pub transport_sequence: i64,
    pub status: String,
    pub mirror_generation: i64,
    pub registry_revision: Option<i64>,
    pub chunk_revision: Option<i64>,
    pub reason: Option<String>,
    pub payload_fingerprint: Option<String>,
    pub skipped_updates: Option<i64>,
}

#[napi(object)]
pub struct MirrorHealthJs {
    pub desynced: bool,
    pub stopped: bool,
    pub loaded_chunks: u32,
    pub pending_imports: u32,
    pub queued_updates: u32,
    pub registry_ready: bool,
    pub registry_revision: i64,
    pub last_transport_sequence: i64,
    pub replay_window_len: u32,
    pub replay_window_floor: Option<i64>,
    pub mirror_generation: i64,
    pub skipped_updates_total: i64,
}

/// 宽松 tagged 信封（fail-closed 解析：缺字段 → MalformedEnvelope ACK）。
#[napi(object)]
pub struct MirrorEnvelopeJs {
    pub protocol_version: u32,
    pub session_epoch: i64,
    pub dimension_epoch: i64,
    pub transport_sequence: i64,
    pub message: MirrorMessageJs,
}

#[napi(object)]
pub struct MirrorMessageJs {
    /// "registryTable" | "chunkBegin" | "sectionData" | "chunkCommit" |
    /// "chunkUnload" | "blockUpdateBatch"
    pub kind: String,
    pub chunk_x: Option<i32>,
    pub chunk_z: Option<i32>,
    /// registryTable：revision。
    pub revision: Option<i64>,
    /// registryTable：stateId→mask 全表（LE u32 字节流）。
    pub masks: Option<Buffer>,
    pub minecraft_version: Option<String>,
    pub server_profile_id: Option<String>,
    /// sectionData："data"|"empty"|"notPresent"。
    pub payload_kind: Option<String>,
    pub section_y: Option<i32>,
    /// empty：显式填充 stateId。
    pub fill_state_id: Option<u32>,
    /// data：长 4096 的 palette 索引（LE u16 字节流）。
    pub palette_indices: Option<Buffer>,
    /// data：palette 条目（class mask 列表）。
    pub palette_entries: Option<Vec<u32>>,
    /// blockUpdateBatch：源事件序号范围/计数。
    pub source_first_sequence: Option<i64>,
    pub source_last_sequence: Option<i64>,
    pub source_event_count: Option<i64>,
    pub coalesced_event_count: Option<i64>,
    /// blockUpdateBatch：flat 四元组 [x,y,z,stateId]×N（有符号 i32 数组）。
    pub updates_flat: Option<Vec<i32>>,
}

#[napi(object)]
pub struct MirrorControlJs {
    /// "worldReset" | "stop" | "healthProbe"
    pub kind: String,
    pub new_session_epoch: Option<i64>,
    pub new_dimension_epoch: Option<i64>,
    /// "sessionRestart" | "dimensionChange" | "desyncRecovery" | "operatorRequest"
    pub reason: Option<String>,
    pub resync_token: Option<i64>,
}

// ---------------------------------------------------------------------------
// 状态/reason 字符串映射（TS 侧字面量对齐）。
// ---------------------------------------------------------------------------

fn status_string(status: AckStatus) -> String {
    match status {
        AckStatus::Applied => "applied",
        AckStatus::SemanticRejected => "semanticRejected",
        AckStatus::IgnoredDuplicate => "ignoredDuplicate",
        AckStatus::IgnoredStale => "ignoredStale",
        AckStatus::GapDesynced => "gapDesynced",
        AckStatus::ProtocolConflict => "protocolConflict",
        AckStatus::WrongEpoch => "wrongEpoch",
        AckStatus::UnsupportedProtocol => "unsupportedProtocol",
        AckStatus::MalformedEnvelope => "malformedEnvelope",
        AckStatus::ResetRequired => "resetRequired",
        AckStatus::QueuedUntilCommit => "queuedUntilCommit",
        AckStatus::ResetApplied => "resetApplied",
        AckStatus::RegistryReady => "registryReady",
        AckStatus::Stopping => "stopping",
        AckStatus::Healthy => "healthy",
    }
    .to_string()
}

fn reason_string(reason: AckReason) -> String {
    match reason {
        AckReason::ChunkNotLoaded => "chunkNotLoaded",
        AckReason::NoOpenImport => "noOpenImport",
        AckReason::RegistryNotReady => "registryNotReady",
        AckReason::RegistryMismatch => "registryMismatch",
        AckReason::InvalidSectionLength => "invalidSectionLength",
        AckReason::UpdateOutsideLoadedChunk => "updateOutsideLoadedChunk",
        AckReason::EpochNotAdvanced => "epochNotAdvanced",
    }
    .to_string()
}

fn malformed_ack(session_epoch: i64, dimension_epoch: i64, transport_sequence: i64) -> MirrorAckJs {
    MirrorAckJs {
        protocol_version: MIRROR_PROTOCOL_VERSION,
        session_epoch,
        dimension_epoch,
        transport_sequence,
        status: "malformedEnvelope".to_string(),
        mirror_generation: 0,
        registry_revision: None,
        chunk_revision: None,
        reason: None,
        payload_fingerprint: None,
        skipped_updates: None,
    }
}

// ---------------------------------------------------------------------------
// 解析。
// ---------------------------------------------------------------------------

fn decode_u32_le(bytes: &[u8]) -> Result<Vec<u32>> {
    if bytes.len() % 4 != 0 {
        return Err(Error::new(
            Status::InvalidArg,
            "u32 buffer length not multiple of 4",
        ));
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|chunk| u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect())
}

fn decode_u16_le(bytes: &[u8]) -> Result<Vec<u16>> {
    if bytes.len() % 2 != 0 {
        return Err(Error::new(
            Status::InvalidArg,
            "u16 buffer length not multiple of 2",
        ));
    }
    Ok(bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect())
}

enum ParsedMessage {
    Data(MirrorMessage),
    Malformed,
}

fn parse_message(js: MirrorMessageJs) -> ParsedMessage {
    let chunk = match (js.chunk_x, js.chunk_z) {
        (Some(x), Some(z)) => Some((x, z)),
        _ => None,
    };
    match js.kind.as_str() {
        "registryTable" => {
            let (Some(revision), Some(masks)) = (js.revision, js.masks) else {
                return ParsedMessage::Malformed;
            };
            let masks = match decode_u32_le(&masks) {
                Ok(masks) if !masks.is_empty() => masks,
                _ => return ParsedMessage::Malformed,
            };
            ParsedMessage::Data(MirrorMessage::RegistryTable {
                revision: revision.max(0) as u64,
                masks,
                minecraft_version: js.minecraft_version,
                server_profile_id: js.server_profile_id,
            })
        }
        "chunkBegin" => match chunk {
            Some(chunk) => ParsedMessage::Data(MirrorMessage::ChunkBegin { chunk }),
            None => ParsedMessage::Malformed,
        },
        "chunkCommit" => match chunk {
            Some(chunk) => ParsedMessage::Data(MirrorMessage::ChunkCommit { chunk }),
            None => ParsedMessage::Malformed,
        },
        "chunkUnload" => match chunk {
            Some(chunk) => ParsedMessage::Data(MirrorMessage::ChunkUnload { chunk }),
            None => ParsedMessage::Malformed,
        },
        "sectionData" => {
            let Some(chunk) = chunk else {
                return ParsedMessage::Malformed;
            };
            let Some(section_y) = js.section_y else {
                return ParsedMessage::Malformed;
            };
            let payload = match js.payload_kind.as_deref() {
                Some("data") => {
                    let (Some(indices), Some(entries)) = (js.palette_indices, js.palette_entries)
                    else {
                        return ParsedMessage::Malformed;
                    };
                    let indices = match decode_u16_le(&indices) {
                        Ok(indices) => indices,
                        Err(_) => return ParsedMessage::Malformed,
                    };
                    if indices.len() != SECTION_CELLS || entries.is_empty() {
                        return ParsedMessage::Malformed;
                    }
                    for &index in &indices {
                        if index as usize >= entries.len() {
                            return ParsedMessage::Malformed;
                        }
                    }
                    SectionPayload::Data {
                        section_y,
                        palette_indices: indices.into_boxed_slice(),
                        palette_entries: entries,
                    }
                }
                Some("empty") => {
                    let Some(fill_state_id) = js.fill_state_id else {
                        return ParsedMessage::Malformed;
                    };
                    SectionPayload::Empty {
                        section_y,
                        fill_state_id,
                    }
                }
                Some("notPresent") => SectionPayload::NotPresent { section_y },
                _ => return ParsedMessage::Malformed,
            };
            ParsedMessage::Data(MirrorMessage::SectionData { chunk, payload })
        }
        "blockUpdateBatch" => {
            let (
                Some(source_first),
                Some(source_last),
                Some(source_event_count),
                Some(updates_flat),
            ) = (
                js.source_first_sequence,
                js.source_last_sequence,
                js.source_event_count,
                js.updates_flat,
            )
            else {
                return ParsedMessage::Malformed;
            };
            if updates_flat.is_empty() || updates_flat.len() % 4 != 0 {
                return ParsedMessage::Malformed;
            }
            let mut updates = Vec::with_capacity(updates_flat.len() / 4);
            for entry in updates_flat.chunks_exact(4) {
                updates.push(BlockUpdateEntry {
                    position: (entry[0], entry[1], entry[2]),
                    state_id: entry[3] as u32,
                });
            }
            ParsedMessage::Data(MirrorMessage::BlockUpdateBatch {
                source_first_sequence: source_first.max(0) as u64,
                source_last_sequence: source_last.max(0) as u64,
                source_event_count: source_event_count.max(0) as u64,
                coalesced_event_count: js.coalesced_event_count.map(|count| count.max(0) as u64),
                updates,
            })
        }
        _ => ParsedMessage::Malformed,
    }
}

fn ack_to_js(ack: crate::world_mirror_protocol::MirrorAck) -> MirrorAckJs {
    MirrorAckJs {
        protocol_version: ack.protocol_version,
        session_epoch: ack.session_epoch as i64,
        dimension_epoch: ack.dimension_epoch as i64,
        transport_sequence: ack.transport_sequence as i64,
        status: status_string(ack.status),
        mirror_generation: ack.mirror_generation as i64,
        registry_revision: ack.registry_revision.map(|value| value as i64),
        chunk_revision: ack.chunk_revision.map(|value| value as i64),
        reason: ack.reason.map(reason_string),
        payload_fingerprint: ack.payload_fingerprint.map(|value| value.to_string()),
        skipped_updates: ack.skipped_updates.map(|value| value as i64),
    }
}

fn health_to_js(health: &MirrorHealth) -> MirrorHealthJs {
    MirrorHealthJs {
        desynced: health.desynced,
        stopped: health.stopped,
        loaded_chunks: health.loaded_chunks as u32,
        pending_imports: health.pending_imports as u32,
        queued_updates: health.queued_updates as u32,
        registry_ready: health.registry_ready,
        registry_revision: health.registry_revision as i64,
        last_transport_sequence: health.last_transport_sequence as i64,
        replay_window_len: health.replay_window_len as u32,
        replay_window_floor: health.replay_window_floor.map(|value| value as i64),
        mirror_generation: health.mirror_generation as i64,
        skipped_updates_total: health.skipped_updates_total as i64,
    }
}

// ---------------------------------------------------------------------------
// 导出函数。
// ---------------------------------------------------------------------------

#[napi]
pub fn mirror_create(
    session_epoch: i64,
    dimension_epoch: i64,
    replay_capacity: Option<u32>,
) -> Result<u32> {
    let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
    let session = match replay_capacity {
        Some(capacity) if capacity > 0 => MirrorSession::with_replay_capacity(
            session_epoch.max(0) as u64,
            dimension_epoch.max(0) as u64,
            capacity as usize,
        ),
        _ => MirrorSession::new(session_epoch.max(0) as u64, dimension_epoch.max(0) as u64),
    };
    SESSIONS
        .try_with(|sessions| {
            sessions
                .try_borrow_mut()
                .map(|mut map| map.insert(handle, session))
        })
        .map_err(|_| Error::new(Status::GenericFailure, "mirror registry unavailable"))?
        .map_err(|_| Error::new(Status::GenericFailure, "mirror registry borrowed"))?;
    Ok(handle)
}

#[napi]
pub fn mirror_submit_envelope(handle: u32, envelope: MirrorEnvelopeJs) -> Result<MirrorAckJs> {
    with_session(handle, |session| {
        let message = match parse_message(envelope.message) {
            ParsedMessage::Data(message) => message,
            ParsedMessage::Malformed => {
                return malformed_ack(
                    envelope.session_epoch,
                    envelope.dimension_epoch,
                    envelope.transport_sequence,
                )
            }
        };
        let parsed = MirrorEnvelope {
            protocol_version: envelope.protocol_version,
            session_epoch: envelope.session_epoch.max(0) as u64,
            dimension_epoch: envelope.dimension_epoch.max(0) as u64,
            transport_sequence: envelope.transport_sequence.max(0) as u64,
            message,
        };
        ack_to_js(session.submit_envelope(parsed))
    })
}

#[napi]
pub fn mirror_submit_control(handle: u32, control: MirrorControlJs) -> Result<MirrorAckJs> {
    with_session(handle, |session| {
        let parsed = match control.kind.as_str() {
            "worldReset" => {
                let (Some(new_session), Some(new_dimension)) =
                    (control.new_session_epoch, control.new_dimension_epoch)
                else {
                    return malformed_ack(0, 0, 0);
                };
                let reason = match control.reason.as_deref() {
                    Some("dimensionChange") => WorldResetReason::DimensionChange,
                    Some("desyncRecovery") => WorldResetReason::DesyncRecovery,
                    Some("operatorRequest") => WorldResetReason::OperatorRequest,
                    _ => WorldResetReason::SessionRestart,
                };
                MirrorControl::WorldReset {
                    new_session_epoch: new_session.max(0) as u64,
                    new_dimension_epoch: new_dimension.max(0) as u64,
                    reason,
                    resync_token: control.resync_token.unwrap_or(0).max(0) as u64,
                }
            }
            "stop" => MirrorControl::Stop,
            "healthProbe" => MirrorControl::HealthProbe,
            _ => return malformed_ack(0, 0, 0),
        };
        ack_to_js(session.submit_control(&parsed))
    })
}

#[napi]
pub fn mirror_health(handle: u32) -> Result<MirrorHealthJs> {
    with_session(handle, |session| health_to_js(&session.health()))
}

#[napi]
pub fn mirror_dispose(handle: u32) -> Result<bool> {
    let removed = SESSIONS
        .try_with(|sessions| {
            sessions
                .try_borrow_mut()
                .map(|mut map| map.remove(&handle).is_some())
        })
        .map_err(|_| Error::new(Status::GenericFailure, "mirror registry unavailable"))?
        .map_err(|_| Error::new(Status::GenericFailure, "mirror registry borrowed"))?;
    Ok(removed)
}
