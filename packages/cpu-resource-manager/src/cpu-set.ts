const CPU_ID_MAXIMUM = 1_048_575;

export type CpuSetParseErrorCode =
  | "CPU_SET_EMPTY"
  | "CPU_SET_INVALID"
  | "CPU_SET_TOO_LARGE";

export class CpuSetParseError extends Error {
  readonly code: CpuSetParseErrorCode;

  constructor(code: CpuSetParseErrorCode, message: string) {
    super(message);
    this.name = "CpuSetParseError";
    this.code = code;
  }
}

export function parseCpuList(value: string): number[] {
  const normalized = value.trim();
  if (!normalized) {
    throw new CpuSetParseError("CPU_SET_EMPTY", "CPU list is empty.");
  }

  const result = new Set<number>();
  for (const token of normalized.split(",")) {
    if (/^[0-9]+$/u.test(token)) {
      addCpu(result, Number(token));
      continue;
    }

    const range = token.match(/^([0-9]+)-([0-9]+)$/u);
    if (!range?.[1] || !range[2]) {
      throw new CpuSetParseError(
        "CPU_SET_INVALID",
        "CPU list contains an invalid token.",
      );
    }
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end
    ) {
      throw new CpuSetParseError(
        "CPU_SET_INVALID",
        "CPU range is invalid.",
      );
    }
    if (end - start > CPU_ID_MAXIMUM) {
      throw new CpuSetParseError(
        "CPU_SET_TOO_LARGE",
        "CPU range exceeds the parser safety boundary.",
      );
    }
    for (let id = start; id <= end; id += 1) addCpu(result, id);
  }

  return [...result].sort((left, right) => left - right);
}

export function formatCpuList(cpuIds: readonly number[]): string {
  const sorted = normalizeCpuIds(cpuIds);
  if (sorted.length === 0) {
    throw new CpuSetParseError("CPU_SET_EMPTY", "CPU list is empty.");
  }

  const ranges: string[] = [];
  let start = sorted[0]!;
  let previous = start;
  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index]!;
    if (current === previous + 1) {
      previous = current;
      continue;
    }
    ranges.push(start === previous ? String(start) : `${start}-${previous}`);
    start = current;
    previous = current;
  }
  ranges.push(start === previous ? String(start) : `${start}-${previous}`);
  return ranges.join(",");
}

export function intersectCpuLists(
  left: readonly number[],
  right: readonly number[],
): number[] {
  const allowed = new Set(normalizeCpuIds(right));
  return normalizeCpuIds(left).filter((id) => allowed.has(id));
}

export function normalizeCpuIds(cpuIds: readonly number[]): number[] {
  const result = new Set<number>();
  for (const id of cpuIds) addCpu(result, id);
  return [...result].sort((left, right) => left - right);
}

function addCpu(target: Set<number>, id: number): void {
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new CpuSetParseError("CPU_SET_INVALID", "CPU ID is invalid.");
  }
  if (id > CPU_ID_MAXIMUM) {
    throw new CpuSetParseError(
      "CPU_SET_TOO_LARGE",
      "CPU ID exceeds the parser safety boundary.",
    );
  }
  target.add(id);
}
