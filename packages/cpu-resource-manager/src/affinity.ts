import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

import { formatCpuList, normalizeCpuIds } from "./cpu-set.js";

const execFileAsync = promisify(execFile);

export type AffinityFailureCode =
  | "AFFINITY_DISABLED"
  | "AFFINITY_UNSUPPORTED_PLATFORM"
  | "AFFINITY_CPU_SET_EMPTY"
  | "AFFINITY_PID_INVALID"
  | "AFFINITY_PID_NOT_AUTHORIZED"
  | "AFFINITY_TOOL_UNAVAILABLE"
  | "AFFINITY_PERMISSION_DENIED"
  | "AFFINITY_APPLY_FAILED";

export type AffinityResult = Readonly<{
  applied: boolean;
  pid: number;
  cpuIds: readonly number[];
  source: "taskset" | "noop";
  errorCode?: AffinityFailureCode;
}>;

export type AffinityCommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<void>;

export interface CpuAffinityAdapter {
  apply(pid: number, cpuIds: readonly number[]): Promise<AffinityResult>;
}

const defaultCommandRunner: AffinityCommandRunner = async (
  executable,
  args,
) => {
  await execFileAsync(executable, [...args], {
    encoding: "utf8",
    timeout: 2_500,
    maxBuffer: 128 * 1_024,
    windowsHide: true,
    shell: false,
  });
};

export class LinuxTasksetAffinityAdapter implements CpuAffinityAdapter {
  private readonly platform: NodeJS.Platform;
  private readonly runner: AffinityCommandRunner;

  constructor(options: {
    platform?: NodeJS.Platform;
    commandRunner?: AffinityCommandRunner;
  } = {}) {
    this.platform = options.platform ?? os.platform();
    this.runner = options.commandRunner ?? defaultCommandRunner;
  }

  async apply(pid: number, cpuIds: readonly number[]): Promise<AffinityResult> {
    const normalized = safeCpuIds(cpuIds);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return failure(pid, normalized, "AFFINITY_PID_INVALID", "taskset");
    }
    if (this.platform !== "linux") {
      return failure(
        pid,
        normalized,
        "AFFINITY_UNSUPPORTED_PLATFORM",
        "taskset",
      );
    }
    if (normalized.length === 0) {
      return failure(pid, normalized, "AFFINITY_CPU_SET_EMPTY", "taskset");
    }

    try {
      await this.runner("taskset", [
        "--all-tasks",
        "--pid",
        "--cpu-list",
        formatCpuList(normalized),
        String(pid),
      ]);
      return Object.freeze({
        applied: true,
        pid,
        cpuIds: Object.freeze(normalized),
        source: "taskset",
      });
    } catch (error) {
      return failure(pid, normalized, affinityErrorCode(error), "taskset");
    }
  }
}

export class NoopCpuAffinityAdapter implements CpuAffinityAdapter {
  async apply(pid: number, cpuIds: readonly number[]): Promise<AffinityResult> {
    return failure(pid, safeCpuIds(cpuIds), "AFFINITY_DISABLED", "noop");
  }
}

function failure(
  pid: number,
  cpuIds: readonly number[],
  errorCode: AffinityFailureCode,
  source: "taskset" | "noop",
): AffinityResult {
  return Object.freeze({
    applied: false,
    pid,
    cpuIds: Object.freeze([...cpuIds]),
    source,
    errorCode,
  });
}

function safeCpuIds(cpuIds: readonly number[]): number[] {
  try {
    return normalizeCpuIds(cpuIds);
  } catch {
    return [];
  }
}

function affinityErrorCode(error: unknown): AffinityFailureCode {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  if (code === "ENOENT") return "AFFINITY_TOOL_UNAVAILABLE";
  if (code === "EPERM" || code === "EACCES") {
    return "AFFINITY_PERMISSION_DENIED";
  }
  return "AFFINITY_APPLY_FAILED";
}
