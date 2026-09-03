// movement-sync 整形器测试：服从窗/onGround 重建/速度钳制/卸载恢复。
import { describe, expect, it } from "vitest";
import { MovementSyncShaper, type MovementWire } from "../src/movement-sync.js";

class FakeWire implements MovementWire {
  public sent: Array<{ channel: string; payload: unknown }> = [];
  public listeners = new Map<string, Array<(...args: never[]) => void>>();
  public write(channel: string, payload: unknown): unknown {
    this.sent.push({ channel, payload });
    return undefined;
  }
  public on(event: string, listener: (...args: never[]) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return undefined;
  }
  public off(event: string, listener: (...args: never[]) => void): unknown {
    const list = (this.listeners.get(event) ?? []).filter((l) => l !== listener);
    this.listeners.set(event, list);
    return undefined;
  }
  /** 模拟服务端 setback/传送 */
  public serverPosition(payload: { x: number; y: number; z: number }): void {
    for (const l of this.listeners.get("position") ?? []) {
      (l as unknown as (p: unknown) => void)(payload);
    }
  }
}

function shaperWith(ground: boolean, now: () => number) {
  return new MovementSyncShaper(() => ground, { now });
}

describe("MovementSyncShaper", () => {
  it("服从窗：setback 后短窗内移动包改写为钉住位置 + 地面真值", () => {
    let clock = 10_000;
    const wire = new FakeWire();
    const shaper = shaperWith(true, () => clock);
    shaper.install(wire);

    wire.serverPosition({ x: 0, y: 90, z: 3 });
    clock += 200; // 窗内
    wire.write("position", { x: 5, y: 90.5, z: 8, onGround: false });

    expect(wire.sent).toHaveLength(1);
    expect(wire.sent[0]!.payload).toMatchObject({ x: 0, y: 90, z: 3, onGround: true });
    expect(shaper.stats.setbacks).toBe(1);
    expect(shaper.stats.rewrites).toBe(1);
  });

  it("服从窗过期：恢复自主移动，但 onGround 失真仍被重建", () => {
    let clock = 10_000;
    const wire = new FakeWire();
    shaperWith(true, () => clock).install(wire);

    wire.serverPosition({ x: 0, y: 90, z: 3 });
    clock += 5_000; // 窗外
    wire.write("position", { x: 0.2, y: 90, z: 3.1, onGround: false });

    expect(wire.sent[0]!.payload).toMatchObject({ x: 0.2, y: 90, z: 3.1, onGround: true });
  });

  it("速度钳制：单包水平位移超上限被压缩到上限内", () => {
    let clock = 10_000;
    const wire = new FakeWire();
    shaperWith(true, () => clock).install(wire);

    wire.write("position", { x: 0, y: 90, z: 0, onGround: true });
    wire.write("position", { x: 10, y: 90, z: 0, onGround: true }); // 10 格/包 = 明显超速

    const second = wire.sent[1]!.payload as { x: number; z: number };
    expect(Math.hypot(second.x - 0, second.z - 0)).toBeLessThanOrEqual(0.36);
  });

  it("脚下无实方块时 onGround 不重建（真下坠不撒谎）", () => {
    let clock = 10_000;
    const wire = new FakeWire();
    shaperWith(false, () => clock).install(wire);

    wire.write("position", { x: 0, y: 95, z: 0, onGround: false });
    expect(wire.sent[0]!.payload).toMatchObject({ onGround: false });
  });

  it("flying 状态包：用最后已知位置做地面探测重建 onGround", () => {
    let clock = 10_000;
    const wire = new FakeWire();
    shaperWith(true, () => clock).install(wire);

    wire.write("position", { x: 0, y: 90, z: 0, onGround: true }); // 建立位置
    wire.write("flying", { onGround: false });

    expect(wire.sent[1]!.payload).toMatchObject({ onGround: true });
  });

  it("卸载：write 恢复原实现、监听移除", () => {
    let clock = 10_000;
    const wire = new FakeWire();
    const shaper = shaperWith(true, () => clock);
    const detach = shaper.install(wire);

    detach();
    wire.serverPosition({ x: 1, y: 90, z: 1 }); // 不再计入
    wire.write("position", { x: 99, y: 90, z: 99, onGround: false }); // 原样放行

    expect(shaper.stats.setbacks).toBe(0);
    expect(wire.sent[0]!.payload).toMatchObject({ x: 99, onGround: false });
  });
});
