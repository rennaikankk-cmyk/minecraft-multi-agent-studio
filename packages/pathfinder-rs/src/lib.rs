//! napi 导出层：Node ↔ Rust 的唯一接缝。JS 侧传体素分类体（Buffer）+
//! 起点/终点 + 选项，拿回路径。同步函数——**必须**在 worker_threads 里
//! 调用（见 index.js 的 worker 包装），否则又把计算塞回事件循环。
//!
//! 测试构建纪律（CI Linux 链接修复）：napi 符号只在 Node 运行时存在，
//! 把它们全部关进 `#[cfg(not(test))]`——`cargo test` 的测试二进制
//! （含迁入的内部测试模块）不再引用 napi_*，纯逻辑模块可独立链接。
//! 外部集成测试仍链接非 test 库，不自动获得此隔离。
//! 非 test 构建（`cargo build --release` → .node addon）完全不变。

mod astar;
#[cfg(not(test))]
pub mod mirror_napi;
pub mod world_mirror;
pub mod world_mirror_protocol;

#[cfg(not(test))]
mod node_exports {
    use super::astar;
    use napi::bindgen_prelude::*;
    use napi_derive::napi;

    #[napi(object)]
    pub struct WorldVolume {
        pub sx: i32,
        pub sy: i32,
        pub sz: i32,
        /// 体素分类字节（sx*sy*sz 长，布局 [(y*sz+z)*sx+x]，值见 astar.rs 常量）。
        pub classes: Buffer,
    }

    #[napi(object)]
    pub struct PathPoint {
        pub x: i32,
        pub y: i32,
        pub z: i32,
    }

    #[napi(object)]
    pub struct PathResult {
        /// true=抵达终点；false=预算内 best-effort 部分路径（先走边重算）。
        pub success: bool,
        pub visited_nodes: u32,
        pub elapsed_ms: f64,
        pub path: Vec<PathPoint>,
    }

    #[napi(object)]
    pub struct FindOptionsJs {
        pub max_nodes: Option<u32>,
        pub timeout_ms: Option<f64>,
        pub allow_dig: Option<bool>,
        /// 目标类型："point"（默认）|"near"（半径邻域——死角拾取）|
        /// "classAdjacent"（到达与 goalClass 体素类相邻——挖矿邻接）。
        pub goal_kind: Option<String>,
        /// near 目标的曼哈顿半径。
        pub goal_radius: Option<i32>,
        /// classAdjacent 目标的体素类（0..3）。
        pub goal_class: Option<u8>,
    }

    #[napi]
    pub fn find_path(
        world: WorldVolume,
        start_x: i32,
        start_y: i32,
        start_z: i32,
        goal_x: i32,
        goal_y: i32,
        goal_z: i32,
        opts: Option<FindOptionsJs>,
    ) -> Result<PathResult> {
        let sx = world.sx;
        let sy = world.sy;
        let sz = world.sz;
        let expected = (sx as i64) * (sy as i64) * (sz as i64);
        if expected <= 0 || expected > 64 * 1024 * 1024 {
            return Err(Error::new(
                Status::InvalidArg,
                "world volume dimensions out of range",
            ));
        }
        if world.classes.len() != expected as usize {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "classes length {} != sx*sy*sz {}",
                    world.classes.len(),
                    expected
                ),
            ));
        }
        let volume = astar::Volume {
            sx,
            sy,
            sz,
            classes: world.classes.to_vec(),
        };
        let defaults = astar::FindOptions::default();
        let goal_kind = opts.as_ref().and_then(|o| o.goal_kind.as_deref());
        let goal = match goal_kind {
            Some("near") => astar::Goal::Near {
                center: astar::Pos {
                    x: goal_x,
                    y: goal_y,
                    z: goal_z,
                },
                radius: opts
                    .as_ref()
                    .and_then(|o| o.goal_radius)
                    .unwrap_or(1)
                    .max(0),
            },
            Some("classAdjacent") => astar::Goal::ClassAdjacent {
                class: opts
                    .as_ref()
                    .and_then(|o| o.goal_class)
                    .unwrap_or(astar::CLASS_DIGGABLE)
                    & 0x03,
            },
            _ => astar::Goal::Point(astar::Pos {
                x: goal_x,
                y: goal_y,
                z: goal_z,
            }),
        };
        let options = match opts {
            Some(o) => astar::FindOptions {
                max_nodes: o
                    .max_nodes
                    .map(|v| v as usize)
                    .unwrap_or(defaults.max_nodes),
                timeout_ms: o
                    .timeout_ms
                    .map(|v| v.max(1.0) as u64)
                    .unwrap_or(defaults.timeout_ms),
                allow_dig: o.allow_dig.unwrap_or(defaults.allow_dig),
            },
            None => defaults,
        };
        let result = astar::find_path(
            &volume,
            astar::Pos {
                x: start_x,
                y: start_y,
                z: start_z,
            },
            goal,
            &options,
        );
        Ok(PathResult {
            success: result.success,
            visited_nodes: result.visited_nodes as u32,
            elapsed_ms: result.elapsed_ms,
            path: result
                .path
                .into_iter()
                .map(|p| PathPoint {
                    x: p.x,
                    y: p.y,
                    z: p.z,
                })
                .collect(),
        })
    }
}
