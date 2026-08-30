// ---------------------------------------------------------------------------
// Studio Startup Plan —— 启动模式的单一来源（Single Source of Truth）
//
// 背景：旧 STUDIO_MODE 曾同时表达 deployment 形态（standard/docker/portable/netcafe），
// 与"是否启动本地 Minecraft 测试服"的意图混在一起。本轮拆分：
//
//   STUDIO_MODE           = normal | local_test | e2e      （启动意图）
//   STUDIO_DEPLOYMENT_MODE= standard|docker|portable|netcafe（部署形态）
//
// 优先级（高→低）：
//   1. CLI 显式 --mode 参数
//   2. 新 STUDIO_MODE（只接受三个新值）
//   3. 兼容映射：旧 STUDIO_MODE 值（standard/docker/portable/netcafe）
//      且 STUDIO_DEPLOYMENT_MODE 未设置 → 解释为 deployment mode，
//      startup mode 落回 normal，输出一次性 deprecation warning。
//   4. 默认 normal（绝不隐式启动本地 MC Server）
//
// 本模块是纯函数（除 warning 回调），所有消费方（start-studio、CI、测试）
// 必须通过 resolveStudioStartupPlan 获取计划，禁止各自猜环境。
// ---------------------------------------------------------------------------

import { z } from "zod";

export const studioStartupModeSchema = z.enum(["normal", "local_test", "e2e"]);
export type StudioStartupMode = z.infer<typeof studioStartupModeSchema>;

export const studioDeploymentModeSchema = z.enum(["standard", "docker", "portable", "netcafe"]);
export type StudioDeploymentMode = z.infer<typeof studioDeploymentModeSchema>;

/** 旧 STUDIO_MODE 的取值集合（迁移期兼容）。 */
const LEGACY_DEPLOYMENT_VALUES = new Set<string>(["standard", "docker", "portable", "netcafe"]);

export type LocalServerLifecycle = "not_started" | "session" | "ephemeral" | "persistent";

export interface StudioStartupPlan {
  readonly startupMode: StudioStartupMode;
  readonly deploymentMode: StudioDeploymentMode;
  /** 优先级来源，用于日志/测试断言。 */
  readonly resolvedFrom: "cli" | "studio_mode_env" | "legacy_compat" | "default";
  /** Local Minecraft Server 的期望状态。 */
  readonly localMinecraftServer: Readonly<{
    desired: LocalServerLifecycle;
    /** 期望 lifecycle 下 Studio stop 时的处理。 */
    shutdownPolicy: "n/a" | "stop_on_studio_stop" | "cleanup_after_run" | "keep_unless_explicit";
    startReason: "none" | "local_test_mode" | "e2e" | "manual";
  }>;
  /** 各控制面组件期望状态（NORMAL/local_test/e2e 均为 on）。 */
  readonly components: Readonly<{
    dashboard: boolean;
    coordinator: boolean;
    sharedState: boolean;
    persistence: boolean;
    botManager: boolean;
  }>;
  /** 兼容映射发生时非空。 */
  readonly warnings: readonly string[];
}

export interface ResolveStartupInput {
  /** CLI 显式 --mode（最高优先级），如 "local_test"。 */
  readonly cliMode?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * 解析启动计划。warning 通过返回值携带（同时调用方可打日志），
 * 纯函数无副作用。
 */
export function resolveStudioStartupPlan(input: ResolveStartupInput): StudioStartupPlan {
  const env = input.env ?? {};
  const warnings: string[] = [];

  // 1. CLI 显式
  if (input.cliMode !== undefined && input.cliMode !== "") {
    const parsed = studioStartupModeSchema.safeParse(input.cliMode);
    if (!parsed.success) {
      throw new Error(
        `Invalid --mode '${input.cliMode}': expected normal | local_test | e2e`,
      );
    }
    return planFor(parsed.data, deploymentFromEnv(env), "cli", warnings);
  }

  const studioModeRaw = env.STUDIO_MODE?.trim();
  const deploymentRaw = env.STUDIO_DEPLOYMENT_MODE?.trim();
  const deployment = parseDeployment(deploymentRaw, warnings);

  // 2. 新 STUDIO_MODE 值
  if (studioModeRaw && studioStartupModeSchema.safeParse(studioModeRaw).success) {
    return planFor(studioModeRaw as StudioStartupMode, deployment, "studio_mode_env", warnings);
  }

  // 3. 兼容映射：旧值
  if (studioModeRaw && LEGACY_DEPLOYMENT_VALUES.has(studioModeRaw)) {
    if (deploymentRaw && deploymentRaw !== studioModeRaw) {
      // 两处都给了旧/新 deployment：显式新变量优先，旧值忽略并警告
      warnings.push(
        `STUDIO_MODE='${studioModeRaw}' is a legacy deployment-mode value and conflicts with STUDIO_DEPLOYMENT_MODE='${deploymentRaw}'; keeping STUDIO_DEPLOYMENT_MODE.`,
      );
      return planFor("normal", deployment, "legacy_compat", warnings);
    }
    warnings.push(
      `STUDIO_MODE='${studioModeRaw}' is a legacy deployment-mode value; interpreting it as STUDIO_DEPLOYMENT_MODE. Set STUDIO_MODE=normal|local_test|e2e for startup intent. Startup mode defaults to NORMAL (local Minecraft server NOT started).`,
    );
    return planFor("normal", parseDeployment(studioModeRaw, warnings), "legacy_compat", warnings);
  }

  if (studioModeRaw) {
    throw new Error(
      `Invalid STUDIO_MODE='${studioModeRaw}': expected normal | local_test | e2e (legacy deployment values are mapped with a warning)`,
    );
  }

  // 4. 默认
  return planFor("normal", deployment, "default", warnings);
}

function deploymentFromEnv(env: Readonly<Record<string, string | undefined>>): StudioDeploymentMode {
  const warnings: string[] = [];
  return parseDeployment(env.STUDIO_DEPLOYMENT_MODE?.trim(), warnings);
}

function parseDeployment(
  raw: string | undefined,
  warnings: string[],
): StudioDeploymentMode {
  if (!raw) return "standard";
  const parsed = studioDeploymentModeSchema.safeParse(raw);
  if (!parsed.success) {
    warnings.push(`Invalid STUDIO_DEPLOYMENT_MODE='${raw}'; falling back to 'standard'.`);
    return "standard";
  }
  return parsed.data;
}

function planFor(
  startupMode: StudioStartupMode,
  deploymentMode: StudioDeploymentMode,
  resolvedFrom: StudioStartupPlan["resolvedFrom"],
  warnings: string[],
): StudioStartupPlan {
  const localMinecraftServer = (() => {
    switch (startupMode) {
      case "normal":
        return {
          desired: "not_started" as const,
          shutdownPolicy: "n/a" as const,
          startReason: "none" as const,
        };
      case "local_test":
        return {
          desired: "session" as const,
          shutdownPolicy: "stop_on_studio_stop" as const,
          startReason: "local_test_mode" as const,
        };
      case "e2e":
        return {
          desired: "ephemeral" as const,
          shutdownPolicy: "cleanup_after_run" as const,
          startReason: "e2e" as const,
        };
    }
  })();

  return {
    startupMode,
    deploymentMode,
    resolvedFrom,
    localMinecraftServer,
    components: { dashboard: true, coordinator: true, sharedState: true, persistence: true, botManager: true },
    warnings,
  };
}
