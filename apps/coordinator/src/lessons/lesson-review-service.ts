// ---------------------------------------------------------------------------
// lesson-review-service.ts —— 复盘触发编排（Phase B）。
//
// 纪律：
//   1. 异步：requestReview 立即返回（排队结果经日志可见），绝不阻塞调用方
//      运行时路径；单 profile 单 in-flight，冷却期内去重。
//   2. 触发面：手动（API）/ bot 会话结束（connectionState online→offline
//      翻沿）。两者共用冷却。
//   3. 产出只落盘 + 日志；不派发任务、不改动行为——消费方是 planner 记忆
//      注入（Phase A memory.lessons 字段）。
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { AppLogger } from "@minecraft-studio/observability";
import type { ModelClient } from "../spark-strategy-v1/model-client.js";
import type { ReviewTaskFact } from "./lesson-card.js";
import { askLessonReview, type LessonReviewAccounting } from "./lesson-review.js";
import type { FileLessonStore } from "./lesson-store.js";
import type { FileGoalTemplateProposalStore } from "../goal-template-registry.js";

export const LESSON_REVIEW_COOLDOWN_MS = 10 * 60_000;

export type LessonReviewTrigger = "manual" | "session-end";

export class LessonReviewService {
  private readonly inFlight = new Set<string>();
  private readonly lastRunAtMs = new Map<string, number>();
  private readonly lastConnectionState = new Map<string, string>();

  constructor(private readonly options: Readonly<{
    client: ModelClient;
    store: FileLessonStore;
    /** 终态任务事实供给（通常 taskStateMachine.list() 后过滤）。 */
    taskFacts: () => Promise<readonly ReviewTaskFact[]>;
    /** D2：goal-approach 类 lesson 卡附带产出模板提案（人审后手工实现）。 */
    templateProposals?: FileGoalTemplateProposalStore;
    logger?: AppLogger;
    now?: () => number;
    cooldownMs?: number;
  }>) {}

  /** 手动/会话结束统一入口。冷却期内幂等去重。 */
  requestReview(serverProfileId: string, trigger: LessonReviewTrigger): Readonly<{ queued: boolean; reason?: "cooldown" | "in-flight" | "no-facts" }> {
    const nowMs = this.options.now?.() ?? Date.now();
    const cooldown = this.options.cooldownMs ?? LESSON_REVIEW_COOLDOWN_MS;
    if (this.inFlight.has(serverProfileId)) return { queued: false, reason: "in-flight" };
    const last = this.lastRunAtMs.get(serverProfileId);
    if (last !== undefined && nowMs - last < cooldown) return { queued: false, reason: "cooldown" };
    this.inFlight.add(serverProfileId);
    void this.run(serverProfileId, trigger)
      .catch((error: unknown) => {
        this.options.logger?.warn("coordinator_lesson_review_failed", {
          trigger,
          code: "REVIEW_RUN_FAILED",
          detail: error instanceof Error ? error.message.slice(0, 200) : String(error),
        });
      })
      .finally(() => {
        this.lastRunAtMs.set(serverProfileId, this.options.now?.() ?? Date.now());
        this.inFlight.delete(serverProfileId);
      });
    return { queued: true };
  }

  /** 挂在 bot-registry 订阅链：online→offline 翻沿触发会话结束复盘。 */
  noteConnectionState(botId: string, serverProfileId: string, connectionState: string): void {
    const key = `${serverProfileId}:${botId}`;
    const previous = this.lastConnectionState.get(key);
    this.lastConnectionState.set(key, connectionState);
    if (previous === "online" && connectionState !== "online") {
      this.requestReview(serverProfileId, "session-end");
    }
  }

  private async run(serverProfileId: string, trigger: LessonReviewTrigger): Promise<void> {
    let facts: readonly ReviewTaskFact[];
    try {
      facts = await this.options.taskFacts();
    } catch (error) {
      this.options.logger?.warn("coordinator_lesson_review_failed", {
        serverProfileHash: hashProfile(serverProfileId),
        trigger,
        code: "TASK_FACTS_UNAVAILABLE",
        detail: error instanceof Error ? error.message.slice(0, 200) : String(error),
      });
      return;
    }
    const profileFacts = facts.filter((fact) => fact.goal.length > 0).slice(0, 24);
    if (profileFacts.length === 0) {
      this.options.logger?.info("coordinator_lesson_review_skipped", { trigger, reason: "no-facts" });
      return;
    }
    // taskFacts 不带 profile 字段（task 记录域无 profile）——按 bot 集聚合的
    // 事实集由供给方保证 scope；此处再以注入的 profileId 固定卡的归属。
    const result = await askLessonReview({
      client: this.options.client,
      input: { serverProfileId, taskFacts: profileFacts },
      requestId: `lesson-${randomUUID()}`,
      ...(this.options.now ? { nowMs: this.options.now } : {}),
    });
    let saved = 0;
    for (const card of result.savedCards) {
      try {
        this.options.store.save(card);
        saved++;
        // D2 联动：goal-approach 卡意味着"这类目标该有确定性模板"——落一条
        // 人审提案（不自动注册，解析器永远手工实现）。
        if (card.kind === "goal-approach" && this.options.templateProposals) {
          try {
            this.options.templateProposals.propose({
              source: "lesson",
              patternExample: card.trigger.goalPattern,
              rationale: card.advice,
            });
          } catch {
            this.options.logger?.warn("coordinator_template_proposal_failed", { lessonId: card.lessonId });
          }
        }
      } catch (error) {
        this.options.logger?.warn("coordinator_lesson_review_card_rejected", {
          code: error instanceof Error ? error.message.slice(0, 100) : "save-failed",
        });
      }
    }
    this.options.logger?.info("coordinator_lesson_review_completed", {
      trigger,
      accounting: { ...result.accounting, savedCards: saved } satisfies LessonReviewAccounting & { savedCards: number },
    });
  }
}

/** 日志里不落原始 profile 字符串（可能含部署命名）。 */
function hashProfile(serverProfileId: string): string {
  let hash = 0;
  for (const char of serverProfileId) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return (hash >>> 0).toString(16);
}
