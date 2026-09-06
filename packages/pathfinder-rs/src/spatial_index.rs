//! D3 semantic indexes share the committed chunk's COW lifetime. No block names
//! or gameplay policy live here; the versioned TypeScript registry owns meaning.
use std::collections::{BTreeMap, BinaryHeap};
use std::time::Instant;

use crate::world_mirror::{SectionStatus, SnapshotHandle, CLASS_UNKNOWN_BIT};

pub const SELECTOR_BITS: u32 = (1 << 24) - 1;
pub const MAX_REGISTRY_STATES: usize = 1_048_576;
pub const MAX_LOADED_CHUNKS: usize = 512;
pub const MAX_PENDING_CHUNKS: usize = 32;
pub const MAX_SECTIONS_PER_CHUNK: usize = 64;
pub const MAX_QUEUED_UPDATES: usize = 65_536;
pub const MAX_INDEX_ENTRIES: usize = 2_097_152;
pub const MAX_QUERY_RADIUS: u32 = 96;
pub const MAX_QUERY_COUNT: usize = 256;
pub const MAX_QUERY_VISITS: usize = 131_072;
pub const MAX_QUERY_MS: f64 = 10.0;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SemanticScope {
    pub selector_revision: u32,
    pub bot_session_id: String,
    pub server_profile_id: String,
    pub dimension: String,
    pub minecraft_version: String,
}

impl SemanticScope {
    pub fn valid(&self) -> bool {
        self.selector_revision == 1
            && [
                &self.bot_session_id,
                &self.server_profile_id,
                &self.dimension,
                &self.minecraft_version,
            ]
            .iter()
            .all(|s| !s.is_empty() && s.len() <= 128 && !s.chars().any(char::is_control))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SemanticRegistry {
    pub scope: SemanticScope,
    /// Zero is a known state with no selected interest; bit 31 is UNKNOWN.
    pub selectors: Vec<u32>,
}

impl SemanticRegistry {
    pub fn valid(&self) -> bool {
        self.scope.valid()
            && !self.selectors.is_empty()
            && self.selectors.len() <= MAX_REGISTRY_STATES
            && self
                .selectors
                .iter()
                .all(|s| *s == CLASS_UNKNOWN_BIT || s & !SELECTOR_BITS == 0)
    }
    pub fn classify(&self, state_id: u32, movement_mask: u32) -> u32 {
        if movement_mask == 0 || movement_mask & CLASS_UNKNOWN_BIT != 0 {
            CLASS_UNKNOWN_BIT
        } else {
            self.selectors
                .get(state_id as usize)
                .copied()
                .unwrap_or(CLASS_UNKNOWN_BIT)
        }
    }
}

#[derive(Clone, Default)]
pub struct SectionIndex {
    /// Legacy movement-only payloads cannot establish absence of interests.
    pub available: bool,
    pub cells: BTreeMap<u16, u32>,
}

impl SectionIndex {
    pub fn set(&mut self, local: u16, selectors: u32) {
        if selectors == 0 {
            self.cells.remove(&local);
        } else {
            self.cells.insert(local, selectors);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SelectorMatch {
    Union,
    Intersection,
}

#[derive(Clone, Debug)]
pub struct SpatialQuery {
    pub query_id: String,
    pub session_epoch: u64,
    pub dimension_epoch: u64,
    pub scope: SemanticScope,
    pub origin: (i32, i32, i32),
    pub radius: u32,
    pub count: usize,
    pub selectors: u32,
    pub matching: SelectorMatch,
    pub max_visits: usize,
    pub max_ms: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QueryStatus {
    Complete,
    Incomplete,
    BudgetExceeded,
    InvalidQuery,
    ScopeMismatch,
    NotReady,
    Desynced,
}

impl QueryStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Complete => "complete",
            Self::Incomplete => "incomplete",
            Self::BudgetExceeded => "budgetExceeded",
            Self::InvalidQuery => "invalidQuery",
            Self::ScopeMismatch => "scopeMismatch",
            Self::NotReady => "notReady",
            Self::Desynced => "desynced",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpatialPoint {
    pub x: i32,
    pub y: i32,
    pub z: i32,
    pub selectors: u32,
    pub distance_squared: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConsultedChunk {
    pub x: i32,
    pub z: i32,
    pub revision: Option<u64>,
    pub importing: bool,
}

#[derive(Debug)]
pub struct SpatialResult {
    pub query_id: String,
    pub session_epoch: u64,
    pub dimension_epoch: u64,
    pub scope: Option<SemanticScope>,
    pub generation: u64,
    pub status: QueryStatus,
    pub points: Vec<SpatialPoint>,
    pub consulted_chunks: Vec<ConsultedChunk>,
    pub visited_entries: usize,
    pub elapsed_ms: f64,
}

fn box_distance_squared(origin: (i32, i32, i32), min: (i32, i32, i32)) -> u64 {
    [(origin.0, min.0), (origin.1, min.1), (origin.2, min.2)]
        .iter()
        .map(|&(v, low)| {
            let d = i64::from(v) - i64::from(v.clamp(low, low + 15));
            (d * d) as u64
        })
        .sum()
}

impl SnapshotHandle {
    pub fn spatial_query(&self, query: &SpatialQuery) -> SpatialResult {
        let began = Instant::now();
        let mut result = SpatialResult {
            query_id: query.query_id.clone(),
            session_epoch: self.session_epoch,
            dimension_epoch: self.dimension_epoch,
            scope: self.semantic_registry.as_ref().map(|r| r.scope.clone()),
            generation: self.generation,
            status: QueryStatus::Complete,
            points: Vec::new(),
            consulted_chunks: Vec::new(),
            visited_entries: 0,
            elapsed_ms: 0.0,
        };
        if query.query_id.is_empty()
            || query.query_id.len() > 128
            || !query.scope.valid()
            || query.radius > MAX_QUERY_RADIUS
            || query.count == 0
            || query.count > MAX_QUERY_COUNT
            || query.selectors == 0
            || query.selectors & !SELECTOR_BITS != 0
            || query.max_visits == 0
            || query.max_visits > MAX_QUERY_VISITS
            || !query.max_ms.is_finite()
            || query.max_ms <= 0.0
            || query.max_ms > MAX_QUERY_MS
            || [query.origin.0, query.origin.1, query.origin.2]
                .iter()
                .any(|v| i64::from(*v).abs() > 30_000_000)
        {
            result.status = QueryStatus::InvalidQuery;
            return result;
        }
        if query.session_epoch != self.session_epoch
            || query.dimension_epoch != self.dimension_epoch
        {
            result.status = QueryStatus::ScopeMismatch;
            return result;
        }
        if self.desynced {
            result.status = QueryStatus::Desynced;
            return result;
        }
        let Some(registry) = &self.semantic_registry else {
            result.status = QueryStatus::NotReady;
            return result;
        };
        if query.scope != registry.scope {
            result.status = QueryStatus::ScopeMismatch;
            return result;
        }

        // Bounded top-N heap; no dense world scan, no full result sort/allocation.
        let mut nearest: BinaryHeap<(u64, i32, i32, i32, u32)> = BinaryHeap::new();
        let (ox, oy, oz) = query.origin;
        let r = query.radius as i32;
        let r2 = u64::from(query.radius).pow(2);
        'chunks: for cx in (ox - r) >> 4..=(ox + r) >> 4 {
            for cz in (oz - r) >> 4..=(oz + r) >> 4 {
                if began.elapsed().as_secs_f64() * 1000.0 >= query.max_ms {
                    result.status = QueryStatus::BudgetExceeded;
                    break 'chunks;
                }
                let dx = i64::from(ox - ox.clamp(cx * 16, cx * 16 + 15));
                let dz = i64::from(oz - oz.clamp(cz * 16, cz * 16 + 15));
                if (dx * dx + dz * dz) as u64 > r2 {
                    continue;
                }
                let importing = self.pending_chunks.contains(&(cx, cz));
                let chunk = self.chunks.get(&(cx, cz));
                result.consulted_chunks.push(ConsultedChunk {
                    x: cx,
                    z: cz,
                    revision: chunk.map(|c| c.revision),
                    importing,
                });
                if importing {
                    result.status = QueryStatus::Incomplete;
                    continue;
                }
                let Some(chunk) = chunk else {
                    result.status = QueryStatus::Incomplete;
                    continue;
                };
                for sy in (oy - r) >> 4..=(oy + r) >> 4 {
                    if box_distance_squared(query.origin, (cx * 16, sy * 16, cz * 16)) > r2 {
                        continue;
                    }
                    let Some(section) = chunk.sections.get(&sy) else {
                        result.status = QueryStatus::Incomplete;
                        continue;
                    };
                    if !section.index.available
                        || matches!(
                            section.status,
                            SectionStatus::NotPresent | SectionStatus::Desynced
                        )
                    {
                        result.status = QueryStatus::Incomplete;
                        continue;
                    }
                    for (&local, &selectors) in &section.index.cells {
                        if result.visited_entries >= query.max_visits
                            || (result.visited_entries % 64 == 0
                                && began.elapsed().as_secs_f64() * 1000.0 >= query.max_ms)
                        {
                            result.status = QueryStatus::BudgetExceeded;
                            break 'chunks;
                        }
                        result.visited_entries += 1;
                        let x = cx * 16 + i32::from(local & 15);
                        let z = cz * 16 + i32::from((local >> 4) & 15);
                        let y = sy * 16 + i32::from(local >> 8);
                        let dx = i64::from(x - ox);
                        let dy = i64::from(y - oy);
                        let dz = i64::from(z - oz);
                        let distance = (dx * dx + dy * dy + dz * dz) as u64;
                        if distance > r2 {
                            continue;
                        }
                        if selectors & CLASS_UNKNOWN_BIT != 0 {
                            result.status = QueryStatus::Incomplete;
                            continue;
                        }
                        let matched = match query.matching {
                            SelectorMatch::Union => selectors & query.selectors != 0,
                            SelectorMatch::Intersection => {
                                selectors & query.selectors == query.selectors
                            }
                        };
                        if !matched {
                            continue;
                        }
                        let entry = (distance, x, y, z, selectors);
                        if nearest.len() < query.count {
                            nearest.push(entry);
                        } else if nearest.peek().is_some_and(|worst| entry < *worst) {
                            nearest.pop();
                            nearest.push(entry);
                        }
                    }
                    if began.elapsed().as_secs_f64() * 1000.0 >= query.max_ms {
                        result.status = QueryStatus::BudgetExceeded;
                        break 'chunks;
                    }
                }
            }
        }
        if began.elapsed().as_secs_f64() * 1000.0 >= query.max_ms {
            result.status = QueryStatus::BudgetExceeded;
        }
        if result.status != QueryStatus::BudgetExceeded {
            result.points = nearest
                .into_sorted_vec()
                .into_iter()
                .map(|(distance_squared, x, y, z, selectors)| SpatialPoint {
                    x,
                    y,
                    z,
                    selectors,
                    distance_squared,
                })
                .collect();
        }
        result.elapsed_ms = began.elapsed().as_secs_f64() * 1000.0;
        result
    }
}

#[cfg(test)]
#[path = "spatial_index_tests.rs"]
mod tests;
