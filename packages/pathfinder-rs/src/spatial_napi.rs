use crate::mirror_napi::with_session;
use crate::spatial_index::{SelectorMatch, SemanticScope, SpatialQuery};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::time::Instant;

#[napi(object)]
pub struct SemanticScopeJs {
    pub selector_revision: f64,
    pub bot_session_id: String,
    pub server_profile_id: String,
    pub dimension: String,
    pub minecraft_version: String,
}

#[napi(object)]
pub struct SpatialQueryJs {
    pub query_id: String,
    pub session_epoch: f64,
    pub dimension_epoch: f64,
    pub scope: SemanticScopeJs,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub radius: f64,
    pub count: f64,
    pub selectors: f64,
    pub matching: String,
    pub max_visits: f64,
    pub max_ms: f64,
}

#[napi(object)]
pub struct SpatialPointJs {
    pub x: i32,
    pub y: i32,
    pub z: i32,
    pub selectors: u32,
    pub distance_squared: f64,
}

#[napi(object)]
pub struct ConsultedChunkJs {
    pub x: i32,
    pub z: i32,
    pub revision: Option<f64>,
    pub importing: bool,
}

#[napi(object)]
pub struct SpatialResultJs {
    pub query_id: String,
    pub session_epoch: f64,
    pub dimension_epoch: f64,
    pub scope: Option<SemanticScopeJs>,
    pub generation: f64,
    pub status: String,
    pub points: Vec<SpatialPointJs>,
    pub consulted_chunks: Vec<ConsultedChunkJs>,
    pub visited_entries: u32,
    pub elapsed_ms: f64,
    pub snapshot_build_ms: f64,
    pub snapshot_chunk_entries: u32,
}

fn integer(value: f64, min: f64, max: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value >= min && value <= max
}

#[napi]
pub fn mirror_spatial_query(handle: u32, js: SpatialQueryJs) -> Result<SpatialResultJs> {
    if !integer(js.session_epoch, 0.0, 9_007_199_254_740_991.0)
        || !integer(js.dimension_epoch, 0.0, 9_007_199_254_740_991.0)
        || !integer(js.scope.selector_revision, 1.0, 1.0)
        || [js.x, js.y, js.z]
            .iter()
            .any(|v| !integer(*v, -30_000_000.0, 30_000_000.0))
        || !integer(js.radius, 0.0, 96.0)
        || !integer(js.count, 1.0, 256.0)
        || !integer(js.selectors, 1.0, ((1 << 24) - 1) as f64)
        || !integer(js.max_visits, 1.0, 131_072.0)
    {
        return Err(Error::new(
            Status::InvalidArg,
            "invalid spatial query numeric field",
        ));
    }
    let matching = match js.matching.as_str() {
        "union" => SelectorMatch::Union,
        "intersection" => SelectorMatch::Intersection,
        "each" => SelectorMatch::Each,
        _ => {
            return Err(Error::new(
                Status::InvalidArg,
                "invalid spatial selector operation",
            ))
        }
    };
    let query = SpatialQuery {
        query_id: js.query_id,
        session_epoch: js.session_epoch as u64,
        dimension_epoch: js.dimension_epoch as u64,
        scope: SemanticScope {
            selector_revision: js.scope.selector_revision as u32,
            bot_session_id: js.scope.bot_session_id,
            server_profile_id: js.scope.server_profile_id,
            dimension: js.scope.dimension,
            minecraft_version: js.scope.minecraft_version,
        },
        origin: (js.x as i32, js.y as i32, js.z as i32),
        radius: js.radius as u32,
        count: js.count as usize,
        selectors: js.selectors as u32,
        matching,
        max_visits: js.max_visits as usize,
        max_ms: js.max_ms,
    };
    with_session(handle, |session| {
        if session.health().stopped {
            return Err(Error::new(Status::GenericFailure, "mirror session stopped"));
        }
        let began = Instant::now();
        let snapshot = session.mirror().snapshot_handle();
        let snapshot_build_ms = began.elapsed().as_secs_f64() * 1000.0;
        let snapshot_chunk_entries = snapshot.chunks.len() as u32;
        let result = snapshot.spatial_query(&query);
        Ok(SpatialResultJs {
            query_id: result.query_id,
            session_epoch: result.session_epoch as f64,
            dimension_epoch: result.dimension_epoch as f64,
            scope: result.scope.map(|s| SemanticScopeJs {
                selector_revision: s.selector_revision as f64,
                bot_session_id: s.bot_session_id,
                server_profile_id: s.server_profile_id,
                dimension: s.dimension,
                minecraft_version: s.minecraft_version,
            }),
            generation: result.generation as f64,
            status: result.status.as_str().into(),
            points: result
                .points
                .into_iter()
                .map(|p| SpatialPointJs {
                    x: p.x,
                    y: p.y,
                    z: p.z,
                    selectors: p.selectors,
                    distance_squared: p.distance_squared as f64,
                })
                .collect(),
            consulted_chunks: result
                .consulted_chunks
                .into_iter()
                .map(|c| ConsultedChunkJs {
                    x: c.x,
                    z: c.z,
                    revision: c.revision.map(|r| r as f64),
                    importing: c.importing,
                })
                .collect(),
            visited_entries: result.visited_entries as u32,
            elapsed_ms: result.elapsed_ms,
            snapshot_build_ms,
            snapshot_chunk_entries,
        })
    })?
}

#[napi(object)]
pub struct SpatialMemoryJs {
    pub chunks_loaded: u32,
    pub sections_data: u32,
    pub sections_other: u32,
    pub palette_entries: u32,
    pub index_entries: u32,
    pub approx_bytes: f64,
}

#[napi]
pub fn mirror_spatial_memory(handle: u32) -> Result<SpatialMemoryJs> {
    with_session(handle, |session| {
        let m = session.mirror().memory_stats();
        SpatialMemoryJs {
            chunks_loaded: m.chunks_loaded as u32,
            sections_data: m.sections_data as u32,
            sections_other: m.sections_other as u32,
            palette_entries: m.palette_entries as u32,
            index_entries: m.index_entries as u32,
            approx_bytes: m.approx_bytes as f64,
        }
    })
}
