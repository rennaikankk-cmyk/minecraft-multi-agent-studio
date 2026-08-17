import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  rename,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { detectCpuTopology, type CpuDetectionOptions } from "./detect.js";
import {
  createHardwareProfile,
  type HardwareProfileFacts,
  type RuntimeSizingOptions,
} from "./hardware-profile.js";
import type { HardwareProfile } from "./types.js";

const execFileAsync = promisify(execFile);

export type HardwareProfilerCommandResult = Readonly<{
  stdout: string;
  stderr: string;
}>;

export type HardwareProfilerCommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<HardwareProfilerCommandResult>;

export type HardwareProfilerOptions = Readonly<{
  cpuDetection?: CpuDetectionOptions;
  desiredBots?: number;
  diskPath?: string;
  platform?: NodeJS.Platform;
  now?: () => Date;
  memoryReader?: () => Readonly<{ totalBytes: number; freeBytes: number }>;
  diskReader?: (path: string) => Promise<
    Readonly<{ blockSize: number; blocks: number; availableBlocks: number }>
  >;
  networkReader?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  commandRunner?: HardwareProfilerCommandRunner;
}>;

const defaultCommandRunner: HardwareProfilerCommandRunner = async (
  executable,
  args,
) => {
  const result = await execFileAsync(executable, [...args], {
    encoding: "utf8",
    timeout: 2_500,
    maxBuffer: 256 * 1_024,
    windowsHide: true,
    shell: false,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

const defaultDiskReader = async (
  targetPath: string,
): Promise<{
  blockSize: number;
  blocks: number;
  availableBlocks: number;
}> => {
  const result = await statfs(targetPath);
  return {
    blockSize: result.bsize,
    blocks: result.blocks,
    availableBlocks: result.bavail,
  };
};

export class HardwareProfiler {
  private readonly options: HardwareProfilerOptions;

  constructor(options: HardwareProfilerOptions = {}) {
    this.options = options;
  }

  async detect(): Promise<HardwareProfile> {
    const now = this.options.now ?? (() => new Date());
    const platform =
      this.options.platform ?? this.options.cpuDetection?.platform ?? os.platform();
    const topology = await detectCpuTopology({
      ...this.options.cpuDetection,
      platform,
      now,
    });
    const facts = await collectHardwareFacts({ ...this.options, platform });
    const sizing: RuntimeSizingOptions = this.options.desiredBots === undefined
      ? {}
      : { desiredBots: this.options.desiredBots };
    return createHardwareProfile(topology, facts, sizing);
  }

  async write(outputPath = "hardware-profile.json"): Promise<string> {
    const profile = await this.detect();
    const absolutePath = path.resolve(outputPath);
    const directory = path.dirname(absolutePath);
    const temporaryPath = path.join(
      directory,
      `.${path.basename(absolutePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(profile, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, absolutePath);
      return absolutePath;
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

export async function detectHardwareProfile(
  options: HardwareProfilerOptions = {},
): Promise<HardwareProfile> {
  return new HardwareProfiler(options).detect();
}

export async function writeHardwareProfile(
  outputPath = "hardware-profile.json",
  options: HardwareProfilerOptions = {},
): Promise<string> {
  return new HardwareProfiler(options).write(outputPath);
}

async function collectHardwareFacts(
  options: HardwareProfilerOptions & { platform: NodeJS.Platform },
): Promise<HardwareProfileFacts> {
  const memory = (options.memoryReader ?? (() => ({
    totalBytes: os.totalmem(),
    freeBytes: os.freemem(),
  })))();
  const diskPath = path.resolve(options.diskPath ?? process.cwd());
  const disk = await detectDisk(
    diskPath,
    options.diskReader ?? defaultDiskReader,
  );
  const network = detectNetwork(
    options.networkReader ?? (() => os.networkInterfaces()),
  );
  const gpu = await detectGpu(
    options.platform,
    options.commandRunner ?? defaultCommandRunner,
  );
  return Object.freeze({ memory, disk, network, gpu });
}

async function detectDisk(
  diskPath: string,
  reader: NonNullable<HardwareProfilerOptions["diskReader"]>,
): Promise<HardwareProfileFacts["disk"]> {
  try {
    const value = await reader(diskPath);
    const totalBytes = value.blockSize * value.blocks;
    const freeBytes = value.blockSize * value.availableBlocks;
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes <= 0 ||
      !Number.isSafeInteger(freeBytes) ||
      freeBytes < 0 ||
      freeBytes > totalBytes
    ) {
      throw new Error("disk_size_outside_safe_integer_range");
    }
    return Object.freeze({
      status: "available",
      source: "node-statfs",
      totalBytes,
      freeBytes,
    });
  } catch {
    return Object.freeze({
      status: "unavailable",
      source: "node-statfs",
    });
  }
}

function detectNetwork(
  reader: NonNullable<HardwareProfilerOptions["networkReader"]>,
): HardwareProfileFacts["network"] {
  try {
    const interfaces = reader();
    const activeInterfaceCount = Object.values(interfaces).filter((addresses) =>
      addresses?.some((address) => !address.internal),
    ).length;
    return Object.freeze({
      status: "available",
      source: "node-os-network-interfaces",
      activeInterfaceCount,
    });
  } catch {
    return Object.freeze({
      status: "unavailable",
      source: "node-os-network-interfaces",
      activeInterfaceCount: 0,
    });
  }
}

async function detectGpu(
  platform: NodeJS.Platform,
  runner: HardwareProfilerCommandRunner,
): Promise<HardwareProfileFacts["gpu"]> {
  const probe = gpuProbe(platform);
  if (!probe) {
    return Object.freeze({
      status: "probe_unavailable",
      source: `unsupported-platform:${platform}`,
      devices: Object.freeze([]),
    });
  }
  try {
    const result = await runner(probe.executable, probe.args);
    const devices = probe.parse(`${result.stdout}\n${result.stderr}`)
      .map((name) => name.trim().slice(0, 240))
      .filter(Boolean)
      .map((name) => Object.freeze({ name }));
    return Object.freeze({
      status: devices.length > 0 ? "detected" : "not_detected",
      source: probe.source,
      devices: Object.freeze(devices),
    });
  } catch {
    return Object.freeze({
      status: "probe_unavailable",
      source: probe.source,
      devices: Object.freeze([]),
    });
  }
}

function gpuProbe(platform: NodeJS.Platform): Readonly<{
  executable: string;
  args: readonly string[];
  source: string;
  parse: (value: string) => string[];
}> | null {
  if (platform === "linux") {
    return {
      executable: "lspci",
      args: ["-mm"],
      source: "linux-lspci",
      parse: (value) =>
        value.split(/\r?\n/u).flatMap((line) => {
          const match = line.match(
            /"(?:VGA compatible controller|3D controller|Display controller)"\s+"[^"]+"\s+"([^"]+)"/u,
          );
          return match?.[1] ? [match[1]] : [];
        }),
    };
  }
  if (platform === "win32") {
    return {
      executable: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_VideoController | Select-Object Name | ConvertTo-Json -Compress",
      ],
      source: "windows-cim",
      parse: parseWindowsGpu,
    };
  }
  if (platform === "darwin") {
    return {
      executable: "system_profiler",
      args: ["SPDisplaysDataType", "-json"],
      source: "macos-system-profiler",
      parse: parseMacGpu,
    };
  }
  return null;
}

function parseWindowsGpu(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap((row) => {
    if (typeof row !== "object" || row === null || !("Name" in row)) return [];
    const name = String(row.Name ?? "").trim();
    return name ? [name] : [];
  });
}

function parseMacGpu(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null) return [];
  const rows = (parsed as { SPDisplaysDataType?: unknown }).SPDisplaysDataType;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (typeof row !== "object" || row === null) return [];
    const source = row as Record<string, unknown>;
    const name = String(source.sppci_model ?? source._name ?? "").trim();
    return name ? [name] : [];
  });
}
