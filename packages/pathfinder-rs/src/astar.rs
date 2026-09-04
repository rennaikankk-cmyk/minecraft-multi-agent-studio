//! pathfinder-rs —— minecraft-studio 的体素 A* 寻路引擎（Rust + napi-rs）。
//!
//! 设计纪律（clean-room，与 Baritone 的关系是架构参考不是代码移植）：
//!  - **线程解耦**：addon 只导出同步计算，JS 侧用 worker_threads 调用——
//!    事件循环只剩物理与包收发（对位 Baritone 的后台计算线程）。
//!  - **引擎只认体素分类**：Node 侧按 registry 把方块映射成 class
//!    （Passable/Solid/Diggable/Hazard），Rust 不含任何 MC 知识——
//!    接缝即 clean-room 边界。
//!  - **部分路径**：超时/节点上限时返回朝目标推进最远的 best-effort
//!    路径（对位 Baritone 的 path splicing：先走一段，边走边重算）。
//!
//! 移动语义（与 bot-runtime 的 movements 保守对齐，v1 无搭路/无水下）：
//!  - 平走：目标脚/头可通行且脚下有支撑（solid 或 diggable 顶面）
//!  - 上跳 1：目标两格净空 + 脚下 solid + 当前头顶净空
//!  - 下落 ≤3：逐格可通行，落点有支撑，下方非 hazard
//!  - 挖穿（可选）：脚/头位 diggable 计入额外成本，按已挖语义通行
//!  - hazard 拒入：脚/头/正下方邻域出现液体/火的格全部不进

use std::collections::BinaryHeap;
use std::time::Instant;

/// 体素分类。数值即 Node Buffer 里的字节。
pub const CLASS_PASSABLE: u8 = 0;
pub const CLASS_SOLID: u8 = 1;
pub const CLASS_DIGGABLE: u8 = 2;
pub const CLASS_HAZARD: u8 = 3;

/// 挖一块的额外成本（对齐"能绕就绕、挡路才挖"的产品语义）。
const DIG_COST: f64 = 8.0;
/// 上跳成本（跳比走贵）。
const JUMP_COST: f64 = 3.0;
/// 每格下落的附加成本。
const FALL_COST_PER_BLOCK: f64 = 0.5;
/// 最大安全落差的格数。
const MAX_FALL: i32 = 3;
/// 跑酷跳（跨沟）附加成本（乘 0 保留常量位；实际成本=gap×1.1+落差）。
const LEAP_COST: f64 = 2.5;
/// 跑酷最大跨距（格）。
const MAX_LEAP: i32 = 4;

/// 目标泛型：点/半径邻域/体素类邻接。Baritone 行为族的引擎侧归约——
/// 采集（矿邻接+挖落）、死角拾取（Near 到掉落物列，挖穿可达）、
/// 脱困（起点埋在 diggable 里照常展开，首步即挖出）共用同一 A*。
#[derive(Clone, Copy)]
pub enum Goal {
    Point(Pos),
    Near { center: Pos, radius: i32 },
    /// 到达与任意该 class 方块四向/上下相邻的站立位（挖矿：邻接矿脉）。
    ClassAdjacent { class: u8 },
}

impl Goal {
    fn is_end(&self, vol: &Volume, p: Pos) -> bool {
        match self {
            Goal::Point(g) => *g == p,
            Goal::Near { center, radius } => {
                (p.x - center.x).abs() + (p.y - center.y).abs() + (p.z - center.z).abs() <= *radius
            }
            Goal::ClassAdjacent { class } => [
                (1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1),
            ]
            .iter()
            .any(|(dx, dy, dz)| vol.class(p.x + dx, p.y + dy, p.z + dz) == Some(*class)),
        }
    }

    /// 可采纳下界。ClassAdjacent 对目标位置不可知 → 0（退化为 Dijkstra，
    /// 有界体积内可接受；挖掘目标稀疏时由 max_nodes/timeout 兜底）。
    fn heuristic(&self, p: Pos) -> f64 {
        match self {
            Goal::Point(g) => {
                ((p.x - g.x).abs() + (p.y - g.y).abs() + (p.z - g.z).abs()) as f64
            }
            Goal::Near { center, radius } => {
                let m = ((p.x - center.x).abs() + (p.y - center.y).abs() + (p.z - center.z).abs()) as f64;
                (m - *radius as f64).max(0.0)
            }
            Goal::ClassAdjacent { .. } => 0.0,
        }
    }
}

#[derive(Clone)]
pub struct Volume {
    pub sx: i32,
    pub sy: i32,
    pub sz: i32,
    pub classes: Vec<u8>,
}

impl Volume {
    #[inline]
    fn idx(&self, x: i32, y: i32, z: i32) -> usize {
        ((y as usize * self.sz as usize + z as usize) * self.sx as usize + x as usize) as usize
    }

    #[inline]
    fn in_bounds(&self, x: i32, y: i32, z: i32) -> bool {
        x >= 0 && y >= 0 && z >= 0 && x < self.sx && y < self.sy && z < self.sz
    }

    #[inline]
    fn class(&self, x: i32, y: i32, z: i32) -> Option<u8> {
        if self.in_bounds(x, y, z) {
            Some(self.classes[self.idx(x, y, z)])
        } else {
            None // 界外=未知=按 solid 处理（fail-closed，不许走出体数据）
        }
    }
}

/// 站立体位（脚位）。
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Pos {
    pub x: i32,
    pub y: i32,
    pub z: i32,
}

/// 一次移动的展开结果。
struct Step {
    to: Pos,
    cost: f64,
}

#[derive(Clone, Copy)]
pub struct FindOptions {
    pub max_nodes: usize,
    pub timeout_ms: u64,
    pub allow_dig: bool,
}

impl Default for FindOptions {
    fn default() -> Self {
        // 预算对齐 JS 侧既有 think 预算量级；worker 线程上跑不挤事件循环。
        FindOptions { max_nodes: 200_000, timeout_ms: 5_000, allow_dig: true }
    }
}

pub struct FindResult {
    /// true=抵达终点；false=预算内 best-effort 部分路径。
    pub success: bool,
    pub visited_nodes: usize,
    pub elapsed_ms: f64,
    pub path: Vec<Pos>,
}

/// 脚位站立判定：脚/头可通行（air 或"已挖"语义由调用侧预写 class 决定），
/// 脚下有支撑。
fn can_stand(vol: &Volume, x: i32, y: i32, z: i32) -> bool {
    let feet = vol.class(x, y, z);
    let head = vol.class(x, y + 1, z);
    let ground = vol.class(x, y - 1, z);
    let passable = |c: Option<u8>| c == Some(CLASS_PASSABLE);
    let support = |c: Option<u8>| c == Some(CLASS_SOLID) || c == Some(CLASS_DIGGABLE);
    passable(feet) && passable(head) && support(ground)
}

/// hazard 熏染判定：脚/头/脚下格不许是 hazard（踩在岩浆上方一格也算）。
fn hazard_adjacent(vol: &Volume, x: i32, y: i32, z: i32) -> bool {
    vol.class(x, y, z) == Some(CLASS_HAZARD)
        || vol.class(x, y + 1, z) == Some(CLASS_HAZARD)
        || vol.class(x, y - 1, z) == Some(CLASS_HAZARD)
}

/// 邻域展开：四向平走/上跳/下落/（可选）挖穿/跑酷跳；循环外补挖落。
/// 起点不校验站立（脱困语义：埋在 diggable 里首步即挖出）。
fn expand(vol: &Volume, from: Pos, opts: &FindOptions, out: &mut Vec<Step>) {
    out.clear();
    for (dx, dz) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
        let nx = from.x + dx;
        let nz = from.z + dz;
        if hazard_adjacent(vol, nx, from.y, nz) {
            continue;
        }
        // 1) 平走（含挖穿脚/头位 diggable）
        if let Some(step) = try_walk_or_dig(vol, from, nx, from.y, nz, opts) {
            out.push(step);
        }
        // 2) 上跳 1（目标 y+1；不挖上跳——组合爆炸留给平走处理）
        let jy = from.y + 1;
        if vol.class(nx, jy, nz) == Some(CLASS_PASSABLE)
            && vol.class(nx, jy + 1, nz) == Some(CLASS_PASSABLE)
            && vol.class(nx, jy - 1, nz) == Some(CLASS_SOLID)
            && vol.class(from.x, from.y + 2, from.z) == Some(CLASS_PASSABLE)
            && !hazard_adjacent(vol, nx, jy, nz)
        {
            out.push(Step { to: Pos { x: nx, y: jy, z: nz }, cost: JUMP_COST });
        }
        // 3) 下落 ≤3
        for drop in 1..=MAX_FALL {
            let fy = from.y - drop;
            let column_clear = (1..=drop).all(|d| {
                vol.class(nx, from.y - d, nz) == Some(CLASS_PASSABLE)
            });
            if !column_clear {
                break;
            }
            if hazard_adjacent(vol, nx, fy, nz) {
                break;
            }
            if can_stand(vol, nx, fy, nz) {
                out.push(Step {
                    to: Pos { x: nx, y: fy, z: nz },
                    cost: 1.0 + FALL_COST_PER_BLOCK * drop as f64,
                });
                break; // 落到第一个可站立层
            }
        }
        // 4) 跑酷跳（跨沟 2..=MAX_LEAP，落点同层或更低 ≤2）：沟中各列
        //    脚/头净空、起跳头顶净空、落点可站立、无 hazard。
        if vol.class(from.x, from.y + 2, from.z) == Some(CLASS_PASSABLE) {
            for gap in 2..=MAX_LEAP {
                let lx = from.x + dx * gap;
                let lz = from.z + dz * gap;
                let gap_clear = (1..gap).all(|g| {
                    let gx = from.x + dx * g;
                    let gz = from.z + dz * g;
                    vol.class(gx, from.y, gz) == Some(CLASS_PASSABLE)
                        && vol.class(gx, from.y + 1, gz) == Some(CLASS_PASSABLE)
                });
                if !gap_clear {
                    break; // 沟被堵，更远的也不可能
                }
                for drop in 0..=2 {
                    let ly = from.y - drop;
                    if hazard_adjacent(vol, lx, ly, lz) {
                        break;
                    }
                    if drop > 0 {
                        let landing_clear = (1..=drop).all(|d| {
                            vol.class(lx, from.y - d, lz) == Some(CLASS_PASSABLE)
                        });
                        if !landing_clear {
                            break;
                        }
                    }
                    if can_stand(vol, lx, ly, lz) {
                        out.push(Step {
                            to: Pos { x: lx, y: ly, z: lz },
                            cost: gap as f64 * 1.1 + LEAP_COST * 0.0 + FALL_COST_PER_BLOCK * drop as f64,
                        });
                        break;
                    }
                }
            }
        }
    }
    // 5) 挖落（dig-down）：脚下 diggable 且再下一层有支撑、无 hazard——
    //    竖直采矿/下到掉落物所在层（死角拾取的引擎半边）。
    if opts.allow_dig {
        let below = vol.class(from.x, from.y - 1, from.z);
        let support = vol.class(from.x, from.y - 2, from.z);
        let has_support = support == Some(CLASS_SOLID) || support == Some(CLASS_DIGGABLE);
        if below == Some(CLASS_DIGGABLE)
            && has_support
            && vol.class(from.x, from.y - 2, from.z) != Some(CLASS_HAZARD)
        {
            out.push(Step {
                to: Pos { x: from.x, y: from.y - 1, z: from.z },
                cost: 1.0 + DIG_COST,
            });
        }
    }
}

/// 平走（目标同层）：目标脚/头要么已可通行，要么 diggable 且允许挖。
fn try_walk_or_dig(vol: &Volume, from: Pos, nx: i32, ny: i32, nz: i32, opts: &FindOptions) -> Option<Step> {
    let feet = vol.class(nx, ny, nz)?;
    let head = vol.class(nx, ny + 1, nz)?;
    let ground = vol.class(nx, ny - 1, nz);
    let support = ground == Some(CLASS_SOLID) || ground == Some(CLASS_DIGGABLE);
    if !support {
        return None;
    }
    if feet == CLASS_PASSABLE && head == CLASS_PASSABLE {
        return Some(Step { to: Pos { x: nx, y: ny, z: nz }, cost: 1.0 });
    }
    if !opts.allow_dig {
        return None;
    }
    let mut digs = 0.0f64;
    if feet == CLASS_DIGGABLE {
        digs += 1.0;
    } else if feet != CLASS_PASSABLE {
        return None;
    }
    if head == CLASS_DIGGABLE {
        digs += 1.0;
    } else if head != CLASS_PASSABLE {
        return None;
    }
    let _ = from;
    Some(Step { to: Pos { x: nx, y: ny, z: nz }, cost: 1.0 + DIG_COST * digs })
}

#[derive(PartialEq)]
struct OpenEntry {
    f: f64,
    pos: Pos,
}

impl Eq for OpenEntry {}

impl Ord for OpenEntry {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        // BinaryHeap 是最大堆：f 小者优先 → Reverse 比较（f 相同按坐标稳定序）。
        other
            .f
            .partial_cmp(&self.f)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                (other.pos.y, other.pos.x, other.pos.z).cmp(&(self.pos.y, self.pos.x, self.pos.z))
            })
    }
}

impl PartialOrd for OpenEntry {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

#[inline]
fn key(vol: &Volume, p: Pos) -> usize {
    vol.idx(p.x, p.y, p.z)
}

/// A* 主体。start 为脚位（不校验站立——脱困语义）；goal 见 Goal。
/// 返回含 start 的路径（终点满足 goal）。
pub fn find_path(vol: &Volume, start: Pos, goal: Goal, opts: &FindOptions) -> FindResult {
    let began = Instant::now();
    let total = (vol.sx as usize) * (vol.sy as usize) * (vol.sz as usize);
    let mut g_score = vec![f64::INFINITY; total];
    let mut came_from = vec![u32::MAX; total]; // 前驱体索引
    let mut closed = vec![false; total];
    let mut open: BinaryHeap<OpenEntry> = BinaryHeap::new();
    let mut steps_buf: Vec<Step> = Vec::with_capacity(24);

    let start_key = key(vol, start);
    g_score[start_key] = 0.0;
    open.push(OpenEntry { f: goal.heuristic(start), pos: start });

    let mut visited: usize = 0;
    let mut best_key = start_key;
    let mut best_h = goal.heuristic(start);

    let deadline = began + std::time::Duration::from_millis(opts.timeout_ms);

    while let Some(OpenEntry { f: _, pos }) = open.pop() {
        if began >= deadline || visited >= opts.max_nodes {
            break;
        }
        let k = key(vol, pos);
        if closed[k] {
            continue;
        }
        closed[k] = true;
        visited += 1;

        if goal.is_end(vol, pos) {
            return FindResult {
                success: true,
                visited_nodes: visited,
                elapsed_ms: began.elapsed().as_secs_f64() * 1000.0,
                path: reconstruct(vol, &came_from, k),
            };
        }

        let h = goal.heuristic(pos);
        if h < best_h {
            best_h = h;
            best_key = k;
        }

        expand(vol, pos, opts, &mut steps_buf);
        for step in steps_buf.drain(..) {
            let nk = key(vol, step.to);
            if closed[nk] || nk == start_key {
                continue;
            }
            let tentative = g_score[k] + step.cost;
            if tentative < g_score[nk] {
                g_score[nk] = tentative;
                came_from[nk] = k as u32;
                open.push(OpenEntry { f: tentative + goal.heuristic(step.to), pos: step.to });
            }
        }
    }

    FindResult {
        success: false,
        visited_nodes: visited,
        elapsed_ms: began.elapsed().as_secs_f64() * 1000.0,
        path: reconstruct(vol, &came_from, best_key),
    }
}

fn reconstruct(vol: &Volume, came_from: &[u32], mut k: usize) -> Vec<Pos> {
    let mut path = Vec::new();
    while k != u32::MAX as usize {
        let idx = k;
        let sx = vol.sx as usize;
        let sz = vol.sz as usize;
        let x = (idx % sx) as i32;
        let rest = idx / sx;
        let z = (rest % sz) as i32;
        let y = (rest / sz) as i32;
        path.push(Pos { x, y, z });
        let prev = came_from[idx];
        if prev == u32::MAX {
            break;
        }
        k = prev as usize;
    }
    path.reverse();
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn flat_world(sx: i32, sy: i32, sz: i32, ground_y: i32) -> Volume {
        let mut classes = vec![CLASS_PASSABLE; (sx * sy * sz) as usize];
        for x in 0..sx {
            for z in 0..sz {
                for y in 0..ground_y {
                    classes[((y * sz + z) * sx + x) as usize] = CLASS_SOLID;
                }
            }
        }
        Volume { sx, sy, sz, classes }
    }

    #[test]
    fn walks_flat_ground() {
        let vol = flat_world(16, 6, 3, 2);
        let result = find_path(
            &vol,
            Pos { x: 0, y: 2, z: 1 },
            Goal::Point(Pos { x: 15, y: 2, z: 1 }),
            &FindOptions::default(),
        );
        assert!(result.success, "should reach, visited={}", result.visited_nodes);
        assert_eq!(result.path.len(), 16);
        assert_eq!(result.path.last().unwrap().x, 15);
    }

    #[test]
    fn digs_through_a_wall_when_allowed() {
        let mut vol = flat_world(16, 6, 3, 2);
        // x=8 处一堵 diggable 墙（脚+头）
        for y in 2..=3 {
            for z in 0..3 {
                vol.classes[((y * vol.sz + z) * vol.sx + 8) as usize] = CLASS_DIGGABLE;
            }
        }
        let opts = FindOptions { allow_dig: true, ..FindOptions::default() };
        let result = find_path(&vol, Pos { x: 4, y: 2, z: 1 }, Goal::Point(Pos { x: 12, y: 2, z: 1 }), &opts);
        assert!(result.success);
        // 挖穿成本体现在路径之外别无绕路（z 向只有 3 格仍走直线）
        assert!(result.path.iter().any(|p| p.x == 8));

        let no_dig = FindOptions { allow_dig: false, ..FindOptions::default() };
        let blocked = find_path(&vol, Pos { x: 4, y: 2, z: 1 }, Goal::Point(Pos { x: 12, y: 2, z: 1 }), &no_dig);
        assert!(!blocked.success);
    }

    #[test]
    fn refuses_hazard_cells() {
        let mut vol = flat_world(16, 6, 3, 2);
        // 走廊正中铺 hazard（岩浆），无绕路
        for z in 0..3 {
            vol.classes[((2 * vol.sz + z) * vol.sx + 8) as usize] = CLASS_HAZARD;
            vol.classes[((1 * vol.sz + z) * vol.sx + 8) as usize] = CLASS_HAZARD;
        }
        let result = find_path(
            &vol,
            Pos { x: 4, y: 2, z: 1 },
            Goal::Point(Pos { x: 12, y: 2, z: 1 }),
            &FindOptions::default(),
        );
        assert!(!result.success, "hazard corridor must not be pathed through");
    }

    #[test]
    fn partial_path_on_unreachable_goal() {
        // 目标封在实心里：不可达 → 返回朝目标推进最远的部分路径
        let vol = flat_world(64, 8, 3, 2);
        let result = find_path(
            &vol,
            Pos { x: 0, y: 2, z: 1 },
            Goal::Point(Pos { x: 63, y: 2, z: 1 }),
            &FindOptions { max_nodes: 50, ..FindOptions::default() },
        );
        assert!(!result.success);
        assert!(!result.path.is_empty(), "best-effort partial path expected");
    }

    #[test]
    fn jumps_and_falls_terrain_steps() {
        let mut vol = flat_world(16, 10, 3, 2);
        // x=6..15 抬高一层（y=2 变 solid，可行走在 y=3）
        for x in 6..16 {
            for z in 0..3 {
                vol.classes[((2 * vol.sz + z) * vol.sx + x) as usize] = CLASS_SOLID;
            }
        }
        let result = find_path(
            &vol,
            Pos { x: 3, y: 2, z: 1 },
            Goal::Point(Pos { x: 10, y: 3, z: 1 }),
            &FindOptions::default(),
        );
        assert!(result.success, "1-block step must be jumpable");
    }

    #[test]
    fn out_of_bounds_is_fail_closed() {
        let vol = flat_world(8, 6, 3, 2);
        let result = find_path(
            &vol,
            Pos { x: 1, y: 2, z: 1 },
            Goal::Point(Pos { x: 100, y: 2, z: 1 }), // 界外目标
            &FindOptions::default(),
        );
        assert!(!result.success);
    }
}

#[cfg(test)]
mod behavior_tests {
    use super::*;
    use super::tests::flat_world;

    /// 埋点起点（脱困）：bot 被困在 diggable 里，路径首步即挖出。
    #[test]
    fn digs_out_of_buried_start() {
        let mut vol = flat_world(12, 8, 3, 2);
        // (4,2..3,1) 埋在 diggable 里（四周+头顶）
        for (dx, dy, dz) in [
            (0, 0, 0), (0, 1, 0), (0, 2, 0),
            (1, 0, 0), (-1, 0, 0), (0, 0, 1), (0, 0, -1),
        ] {
            let idx = (((2 + dy) * vol.sz + (1 + dz)) * vol.sx + (4 + dx)) as usize;
            vol.classes[idx] = CLASS_DIGGABLE;
        }
        vol.classes[((2 * vol.sz + 1) * vol.sx + 4) as usize] = CLASS_PASSABLE; // 脚位本身是"站着的格"
        let result = find_path(
            &vol,
            Pos { x: 4, y: 2, z: 1 },
            Goal::Point(Pos { x: 10, y: 2, z: 1 }),
            &FindOptions::default(),
        );
        assert!(result.success, "buried start must dig out, visited={}", result.visited_nodes);
    }

    /// 跑酷跳：3 格沟（两层深），两端平台——走路绕不过去，必须跳。
    #[test]
    fn leaps_across_a_gap() {
        let mut vol = flat_world(16, 10, 3, 2);
        // x=5..8 挖穿到 y=0（沟），深度 2：落入可爬出但绕路远
        for x in 5..=7 {
            for z in 0..3 {
                vol.classes[((1 * vol.sz + z) * vol.sx + x) as usize] = CLASS_PASSABLE;
                vol.classes[((2 * vol.sz + z) * vol.sx + x) as usize] = CLASS_PASSABLE;
            }
        }
        let result = find_path(
            &vol,
            Pos { x: 3, y: 2, z: 1 },
            Goal::Point(Pos { x: 10, y: 2, z: 1 }),
            &FindOptions::default(),
        );
        assert!(result.success, "4-wide gap must be crossable by leap");
        // 路径必须包含一次 ≥3 格的水平跳（连续点 x 差 >1）
        let mut has_leap = false;
        for w in result.path.windows(2) {
            let (a, b) = (w[0], w[1]);
            if (b.x - a.x).abs() + (b.z - a.z).abs() > 1 {
                has_leap = true;
            }
        }
        assert!(has_leap, "expected a leap step in the path");
    }

    /// 挖落（dig-down）：目标在下一层平台上，必须挖脚下的 diggable 才能下去。
    #[test]
    fn digs_down_to_lower_level() {
        let mut vol = flat_world(8, 10, 3, 4);
        for y in 2..=4 {
            vol.classes[((y * vol.sz + 1) * vol.sx + 2) as usize] = CLASS_DIGGABLE;
        }
        // 在 (2..,3..) 区域 y=3 挖空成下层房间？简化：站在实心柱顶，脚下全 diggable 柱
        let result = find_path(
            &vol,
            Pos { x: 2, y: 5, z: 1 },
            Goal::Point(Pos { x: 2, y: 2, z: 1 }), // 目标在柱内部下方——挖落可达
            &FindOptions::default(),
        );
        assert!(result.success, "dig-down chain must reach lower cells");
    }

    /// 类邻接目标（挖矿）：到达与指定 class 相邻的任意站立位。
    #[test]
    fn paths_to_class_adjacent_goal() {
        let mut vol = flat_world(16, 8, 3, 2);
        // "矿"在 x=10, y=2（嵌入地面表层）——注意 ground y=0..2 solid，矿替换 y=2 那格？
        // 简化：把 (10, 3, 1) 标成目标类（空中的目标块），可达=走到其邻接站立位
        vol.classes[((3 * vol.sz + 1) * vol.sx + 10) as usize] = CLASS_SOLID;
        let result = find_path(
            &vol,
            Pos { x: 2, y: 2, z: 1 },
            Goal::ClassAdjacent { class: CLASS_SOLID },
            &FindOptions::default(),
        );
        // 起点本身就与地面(固体)相邻——is_end 立即成立。换成稀有类再测真实搜索：
        assert!(result.success);
        assert_eq!(result.path.len(), 1); // 起点即满足（与地面相邻）

        // 真实搜索场景：DIGGER 目标类只出现在墙后
        let mut vol2 = flat_world(16, 8, 3, 2);
        vol2.classes[((2 * vol2.sz + 1) * vol2.sx + 12) as usize] = CLASS_DIGGABLE;
        let mining = find_path(
            &vol2,
            Pos { x: 2, y: 2, z: 1 },
            Goal::ClassAdjacent { class: CLASS_DIGGABLE },
            &FindOptions::default(),
        );
        assert!(mining.success);
        let end = mining.path.last().unwrap();
        let adjacent = [
            (1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1),
        ]
        .iter()
        .any(|(dx, dy, dz)| {
            vol2.class(end.x + dx, end.y + dy, end.z + dz) == Some(CLASS_DIGGABLE)
        });
        assert!(adjacent, "path must end adjacent to the target class");
    }

    /// 半径目标（死角拾取）：掉落物在坑底，Near 半径覆盖其列。
    #[test]
    fn near_goal_reaches_drop_column() {
        let mut vol = flat_world(16, 12, 3, 2);
        // x=8 处一个 3 深的竖井（开口在地面），"掉落物"在井底 (8, 0, 1)
        for y in 1..3 {
            vol.classes[((y * vol.sz + 1) * vol.sx + 8) as usize] = CLASS_PASSABLE;
        }
        // 井口封一块 diggable（死角：正常走不到，需挖开+下落）
        vol.classes[((3 * vol.sz + 1) * vol.sx + 8) as usize] = CLASS_DIGGABLE;
        let result = find_path(
            &vol,
            Pos { x: 2, y: 3, z: 1 },
            Goal::Near { center: Pos { x: 8, y: 0, z: 1 }, radius: 1 },
            &FindOptions::default(),
        );
        assert!(result.success, "drop in a shaft must be reachable by dig+fall");
        let end = *result.path.last().unwrap();
        assert!(end.x == 8 && end.y <= 1, "must reach the drop column, got {:?}", end);
    }
}
