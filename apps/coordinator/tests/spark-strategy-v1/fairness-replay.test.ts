import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AIRequestScheduler, aiRequestPriorities } from "@minecraft-studio/ai-router";

afterEach(() => vi.useRealTimers());

describe("5/10 Bot-ID scheduler replay (offline, no Minecraft or inference)", () => {
  for (const bots of [5, 10]) for (const mode of ["burst", "sparse"] as const) {
    it(`${bots} IDs, ${mode}: preserves the global/per-Bot budget and explicit deadlines`, async () => {
      vi.useFakeTimers(); vi.setSystemTime(0);
      const rows: Array<Record<string, unknown>> = [];
      const active = new Map<string, number>(); let running = 0, maxRunning = 0, maxPerBot = 0;
      const scheduler = new AIRequestScheduler({ maxConcurrency: 3, perBotConcurrency: 1, maxQueue: 64 });
      const promises: Promise<void>[] = [];
      const enqueue = (botId: string, kind: "planning" | "chat" | "background", at: number) => {
        setTimeout(() => {
          const began = Date.now();
          // Planning/team use the rounded observed concurrency-3 median. Chat service is an unmeasured assumption.
          const duration = kind === "chat" ? 4_000 : 20_000;
          const promise = scheduler.schedule({ requestId: `${botId}-${kind}`, botId, priority: aiRequestPriorities[kind],
            timeoutMs: kind === "chat" ? 15_000 : kind === "planning" ? 45_000 : 120_000,
            execute: ({ signal }) => new Promise<void>((resolve, reject) => {
              running++; maxRunning = Math.max(maxRunning, running); active.set(botId, (active.get(botId) ?? 0) + 1);
              maxPerBot = Math.max(maxPerBot, active.get(botId)!);
              let settled = false;
              const finish = (aborted: boolean) => {
                if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
                running--; active.set(botId, active.get(botId)! - 1);
                if (aborted) reject(new Error("replay cancelled")); else resolve();
              };
              const abort = () => finish(true);
              const timer = setTimeout(() => finish(false), duration);
              signal.addEventListener("abort", abort, { once: true });
            }),
          }).then((result) => { rows.push({ botId, kind, outcome: "completed", queueMs: result.queueTimeMs, totalMs: result.totalTimeMs }); },
            (error: { code: string }) => { rows.push({ botId, kind, outcome: error.code, totalMs: Date.now() - began }); });
          promises.push(promise);
        }, at);
      };
      for (let i = 0; i < bots; i++) enqueue(`bot-${i}`, "planning", mode === "burst" ? 0 : i * 30_000);
      for (let i = 0; i < 3; i++) enqueue(`bot-${i}`, "chat", mode === "burst" ? 100 : i * 30_000 + 21_000);
      enqueue("team-observer", "background", 200);
      await vi.runAllTimersAsync(); await Promise.all(promises); scheduler.close();
      expect(maxRunning).toBeLessThanOrEqual(3); expect(maxPerBot).toBe(1); expect(running).toBe(0);
      expect(rows).toHaveLength(bots + 4);
      const chatTimeouts = rows.filter((row) => row.kind === "chat" && row.outcome === "AI_REQUEST_TIMEOUT").length;
      if (mode === "burst") expect(chatTimeouts).toBe(3);
      else expect(rows.every((row) => row.outcome === "completed")).toBe(true);
      const evidence = { mode: "OFFLINE_REPLAY", bots, arrival: mode, maxConcurrency: 3, maxRunning, maxPerBot,
        assumptions: { planningMs: 20000, planningSource: "rounded measured concurrency-3 median 19902ms", chatMs: 4000,
          chatSource: "ASSUMED, not measured; live chat timed out", sparseBotIntervalMs: 30000, sparseChatAfterPlanMs: 21000 }, rows };
      if (process.env.SPARK_FAIRNESS_REPORT_DIR) {
        mkdirSync(process.env.SPARK_FAIRNESS_REPORT_DIR, { recursive: true });
        writeFileSync(path.join(process.env.SPARK_FAIRNESS_REPORT_DIR, `fairness-${bots}-${mode}.json`), JSON.stringify(evidence, null, 2));
      }
    });
  }
});
