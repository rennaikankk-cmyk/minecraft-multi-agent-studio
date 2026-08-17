import { readFile } from "node:fs/promises";
import os from "node:os";

import type { CpuLoadSample } from "./types.js";

type CpuTimes = Readonly<{
  total: number;
  idle: number;
}>;

export type ProcStatCpuMonitorOptions = Readonly<{
  now?: () => Date;
  readTextFile?: (path: string) => Promise<string>;
  loadAverage?: () => readonly number[];
}>;

export class ProcStatCpuMonitor {
  private readonly now: () => Date;
  private readonly readTextFile: (path: string) => Promise<string>;
  private readonly loadAverage: () => readonly number[];
  private previous = new Map<string, CpuTimes>();

  constructor(options: ProcStatCpuMonitorOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.readTextFile =
      options.readTextFile ?? ((path) => readFile(path, "utf8"));
    this.loadAverage = options.loadAverage ?? (() => os.loadavg());
  }

  async sample(): Promise<CpuLoadSample> {
    const parsed = parseProcStat(await this.readTextFile("/proc/stat"));
    const perCpuUsagePercent: Record<number, number | null> = {};
    let totalUsagePercent: number | null = null;

    for (const [name, current] of parsed) {
      const usage = usageSince(this.previous.get(name), current);
      if (name === "cpu") totalUsagePercent = usage;
      else {
        const id = Number(name.slice(3));
        if (Number.isSafeInteger(id) && id >= 0) perCpuUsagePercent[id] = usage;
      }
    }
    this.previous = parsed;

    const load = this.loadAverage();
    return Object.freeze({
      capturedAt: this.now().toISOString(),
      totalUsagePercent,
      perCpuUsagePercent: Object.freeze(perCpuUsagePercent),
      loadAverage: Object.freeze([
        finiteOrZero(load[0]),
        finiteOrZero(load[1]),
        finiteOrZero(load[2]),
      ]) as readonly [number, number, number],
    });
  }
}

export function parseProcStat(value: string): Map<string, CpuTimes> {
  const result = new Map<string, CpuTimes>();
  for (const line of value.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    const name = fields[0];
    if (!name || !/^cpu(?:[0-9]+)?$/u.test(name)) continue;
    const values = fields.slice(1, 9).map(Number);
    if (
      values.length < 4 ||
      values.some((item) => !Number.isFinite(item) || item < 0)
    ) {
      continue;
    }
    const user = values[0] ?? 0;
    const nice = values[1] ?? 0;
    const system = values[2] ?? 0;
    const idle = values[3] ?? 0;
    const ioWait = values[4] ?? 0;
    const irq = values[5] ?? 0;
    const softIrq = values[6] ?? 0;
    const steal = values[7] ?? 0;
    const idleTotal = idle + ioWait;
    result.set(name, {
      idle: idleTotal,
      total: user + nice + system + idleTotal + irq + softIrq + steal,
    });
  }
  return result;
}

function usageSince(
  previous: CpuTimes | undefined,
  current: CpuTimes,
): number | null {
  if (!previous) return null;
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0 || idleDelta < 0) return null;
  return clampPercent(((totalDelta - idleDelta) / totalDelta) * 100);
}

function clampPercent(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 100) / 100;
}

function finiteOrZero(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined ? value : 0;
}
