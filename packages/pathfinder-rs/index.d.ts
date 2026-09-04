declare module "@minecraft-studio/pathfinder-rs" {
  export const CLASS: Readonly<{
    PASSABLE: 0;
    SOLID: 1;
    DIGGABLE: 2;
    HAZARD: 3;
  }>;

  export interface WorldVolume {
    sx: number;
    sy: number;
    sz: number;
    /** 体素分类字节（sx*sy*sz，布局 [(y*sz+z)*sx+x]）。 */
    classes: Buffer;
  }

  export interface PathPoint {
    x: number;
    y: number;
    z: number;
  }

  export interface PathResult {
    success: boolean;
    visitedNodes: number;
    elapsedMs: number;
    path: PathPoint[];
  }

  export interface FindOptionsJs {
    maxNodes?: number;
    timeoutMs?: number;
    allowDig?: boolean;
    goalKind?: "point" | "near" | "classAdjacent";
    goalRadius?: number;
    goalClass?: number;
  }

  export function findPathAsync(input: {
    world: WorldVolume;
    start: PathPoint;
    goal: PathPoint;
    options?: FindOptionsJs | null;
  }): Promise<PathResult>;

  export function findPathSync(
    world: WorldVolume,
    start: PathPoint,
    goal: PathPoint,
    options?: FindOptionsJs | null,
  ): PathResult;
}
