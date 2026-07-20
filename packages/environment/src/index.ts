import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

import {
  deploymentModeSchema,
  environmentSnapshotSchema,
  type DeploymentMode,
  type EnvironmentSnapshot,
} from "@minecraft-studio/protocol";

const execFileAsync = promisify(execFile);
const DOCKER_MARKER = "/.dockerenv";

export type CommandResult = {
  stdout: string;
  stderr: string;
};

export type CommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<CommandResult>;

export type DetectionOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?: () => Date;
  commandRunner?: CommandRunner;
  dockerMarkerExists?: () => Promise<boolean>;
};

const defaultCommandRunner: CommandRunner = async (executable, args) => {
  const result = await execFileAsync(executable, [...args], {
    encoding: "utf8",
    timeout: 2_500,
    maxBuffer: 256 * 1024,
    windowsHide: true,
    shell: false,
  });

  return { stdout: result.stdout, stderr: result.stderr };
};

async function defaultDockerMarkerExists(): Promise<boolean> {
  try {
    await access(DOCKER_MARKER);
    return true;
  } catch {
    return false;
  }
}

export function resolveDeploymentMode(
  env: NodeJS.ProcessEnv,
  hasDockerMarker: boolean,
): EnvironmentSnapshot["mode"] {
  const configured = deploymentModeSchema.safeParse(env.STUDIO_MODE);
  if (configured.success) {
    return { value: configured.data, source: "environment" };
  }

  if (hasDockerMarker) {
    return { value: "docker", source: "container-marker" };
  }

  if (env.STUDIO_PORTABLE_ROOT?.trim()) {
    return { value: "portable", source: "portable-root" };
  }

  return { value: "standard", source: "default" };
}

function firstMeaningfulLine(value: string): string | undefined {
  const line = value
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .find(Boolean);
  return line?.slice(0, 240);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String(error.code);
  }
  return undefined;
}

async function probeSoftware(
  id: EnvironmentSnapshot["software"][number]["id"],
  executable: string,
  args: readonly string[],
  runner: CommandRunner,
): Promise<EnvironmentSnapshot["software"][number]> {
  try {
    const result = await runner(executable, args);
    const version = firstMeaningfulLine(`${result.stdout}\n${result.stderr}`);
    return {
      id,
      status: "available",
      ...(version ? { version } : {}),
      source: "local-process-probe",
    };
  } catch (error) {
    const code = errorCode(error);
    return {
      id,
      status: code === "ENOENT" ? "unavailable" : "unknown",
      source: "local-process-probe",
      detail: code ? `probe_error:${code}` : "probe_error",
    };
  }
}

function parseWindowsGpu(value: string): EnvironmentSnapshot["hardware"]["gpu"]["devices"] {
  const parsed: unknown = JSON.parse(value);
  const rows = Array.isArray(parsed) ? parsed : [parsed];

  return rows.flatMap((row) => {
    if (typeof row !== "object" || row === null || !("Name" in row)) {
      return [];
    }

    const source = row as Record<string, unknown>;
    const name = String(source.Name ?? "").trim();
    if (!name) return [];

    const rawMemory = Number(source.AdapterRAM);
    const driverVersion = String(source.DriverVersion ?? "").trim();
    return [
      {
        name,
        ...(Number.isSafeInteger(rawMemory) && rawMemory >= 0
          ? { memoryBytes: rawMemory }
          : {}),
        ...(driverVersion ? { driverVersion } : {}),
      },
    ];
  });
}

function parseLinuxGpu(value: string): EnvironmentSnapshot["hardware"]["gpu"]["devices"] {
  return value.split(/\r?\n/u).flatMap((line) => {
    const match = line.match(
      /"(?:VGA compatible controller|3D controller|Display controller)"\s+"([^"]+)"\s+"([^"]+)"/u,
    );
    if (!match?.[1] || !match[2]) return [];
    return [{ name: match[2], vendor: match[1] }];
  });
}

function parseMacGpu(value: string): EnvironmentSnapshot["hardware"]["gpu"]["devices"] {
  const parsed = JSON.parse(value) as { SPDisplaysDataType?: Array<Record<string, unknown>> };
  return (parsed.SPDisplaysDataType ?? []).flatMap((row) => {
    const name = String(row.sppci_model ?? row._name ?? "").trim();
    return name ? [{ name }] : [];
  });
}

async function detectGpu(
  platform: NodeJS.Platform,
  runner: CommandRunner,
): Promise<{ gpu: EnvironmentSnapshot["hardware"]["gpu"]; warning?: string }> {
  const probes: Partial<Record<NodeJS.Platform, { executable: string; args: string[]; parser: typeof parseWindowsGpu; source: string }>> = {
    win32: {
      executable: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress",
      ],
      parser: parseWindowsGpu,
      source: "windows-cim",
    },
    linux: {
      executable: "lspci",
      args: ["-mm"],
      parser: parseLinuxGpu,
      source: "linux-lspci",
    },
    darwin: {
      executable: "system_profiler",
      args: ["SPDisplaysDataType", "-json"],
      parser: parseMacGpu,
      source: "macos-system-profiler",
    },
  };

  const probe = probes[platform];
  if (!probe) {
    return {
      gpu: { status: "probe_unavailable", source: `unsupported-platform:${platform}`, devices: [] },
      warning: `当前平台 ${platform} 没有 GPU 探测器。`,
    };
  }

  try {
    const result = await runner(probe.executable, probe.args);
    const devices = probe.parser(`${result.stdout}\n${result.stderr}`);
    return {
      gpu: {
        status: devices.length > 0 ? "detected" : "not_detected",
        source: probe.source,
        devices,
      },
    };
  } catch (error) {
    const code = errorCode(error) ?? "unknown";
    return {
      gpu: { status: "probe_unavailable", source: probe.source, devices: [] },
      warning: `GPU 探测不可用（${probe.source}:${code}）。`,
    };
  }
}

function normalizeCpuModel(value: string | undefined): string {
  const model = value?.trim();
  return model || "Unknown CPU reported by operating system";
}

export async function detectEnvironment(
  options: DetectionOptions = {},
): Promise<EnvironmentSnapshot> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? os.platform();
  const runner = options.commandRunner ?? defaultCommandRunner;
  const markerExists = options.dockerMarkerExists ?? defaultDockerMarkerExists;
  const hasDockerMarker = await markerExists();
  const mode = resolveDeploymentMode(env, hasDockerMarker);
  const cpuList = os.cpus();
  const gpuResult = await detectGpu(platform, runner);

  const software = await Promise.all([
    probeSoftware("node", process.execPath, ["--version"], runner),
    probeSoftware("java", "java", ["--version"], runner),
    probeSoftware("docker", "docker", ["--version"], runner),
    probeSoftware("git", "git", ["--version"], runner),
  ]);

  const warnings = gpuResult.warning ? [gpuResult.warning] : [];
  if (mode.value === "netcafe") {
    warnings.push("网吧模式的数据导出、断点恢复和安全清理尚未接入。当前只完成模式识别。");
  }

  return environmentSnapshotSchema.parse({
    schemaVersion: "1.0",
    capturedAt: (options.now ?? (() => new Date()))().toISOString(),
    mode,
    hardware: {
      platform,
      release: os.release(),
      architecture: os.arch(),
      cpu: {
        model: normalizeCpuModel(cpuList[0]?.model),
        logicalCores: Math.max(1, cpuList.length),
      },
      memory: {
        totalBytes: os.totalmem(),
        freeBytes: os.freemem(),
      },
      gpu: gpuResult.gpu,
    },
    software,
    warnings,
  });
}

export type { DeploymentMode, EnvironmentSnapshot } from "@minecraft-studio/protocol";
