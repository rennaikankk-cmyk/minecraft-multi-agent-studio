import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJson,
  lessonFingerprint,
  newLessonId,
  type LessonCard,
  type ReviewTaskFact,
} from "../src/lessons/lesson-card.js";
import {
  askLessonReview,
  buildLessonReviewPrompt,
  parseLessonResponse,
  validateLessonCard,
  type ModelClient,
} from "../src/lessons/lesson-review.js";
import { FileLessonStore } from "../src/lessons/lesson-store.js";
import { LessonReviewService } from "../src/lessons/lesson-review-service.js";

const NOW_MS = 1_800_000_000_000;
const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "lessons-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FACTS: readonly ReviewTaskFact[] = [
  { taskId: "task-1", botId: "bot-01", goal: "collect oak_log", state: "ABORT", failureReason: "COLLECT_PICKUP_NOT_SETTLED", updatedAt: "2026-09-11T10:00:00.000Z" },
  { taskId: "task-2", botId: "bot-01", goal: "collect oak_log", state: "ABORT", failureReason: "COLLECT_PICKUP_NOT_SETTLED", updatedAt: "2026-09-11T10:30:00.000Z" },
  { taskId: "task-3", botId: "bot-01", goal: "smelt iron_ingot", state: "SUCCESS", failureReason: null, updatedAt: "2026-09-11T11:00:00.000Z" },
];

function card(overrides: Partial<LessonCard> = {}): LessonCard {
  const base: LessonCard = {
    schemaVersion: "1.0",
    lessonId: "pending",
    serverProfileId: "profile-a",
    kind: "goal-approach",
    trigger: { goalPattern: "collecting dropped logs under tree canopies", failureCodes: ["COLLECT_PICKUP_NOT_SETTLED"] },
    advice: "Plan a ground collection point before felling; walk to predicted drop position first.",
    confidence: 0.7,
    evidence: [{ taskId: "task-1", outcome: "failed" }, { taskId: "task-2", outcome: "failed" }],
    observedAtMs: NOW_MS,
  };
  const merged = { ...base, ...overrides, trigger: { ...base.trigger, ...(overrides.trigger ?? {}) } };
  return { ...merged, lessonId: newLessonId(merged) };
}

describe("lesson card fingerprint", () => {
  it("is deterministic on semantic fields and ignores identity/time", () => {
    const a = card();
    const b = card({ lessonId: "other-id", observedAtMs: NOW_MS + 999_999 });
    expect(lessonFingerprint(a)).toBe(lessonFingerprint(b));
    expect(lessonFingerprint(card({ advice: "different advice" }))).not.toBe(lessonFingerprint(a));
  });
  it("canonical json sorts keys without whitespace", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
  });
});

describe("parseLessonResponse", () => {
  it("parses a valid lessons envelope", () => {
    const text = `prefix noise {"lessons":[${JSON.stringify({ ...card(), lessonId: "x".repeat(12) })}]} suffix`;
    expect(parseLessonResponse(text).ok).toBe(true);
  });
  it("accounts empty lessons separately from failures", () => {
    expect(parseLessonResponse(`{"lessons":[]}`)).toMatchObject({ ok: false, reason: "no-lessons" });
  });
  it("rejects truncated json with the truncation reason", () => {
    // 有闭括号但括号数不匹配（open 2 / close 1）→ 截断分账而非非法 JSON。
    expect(parseLessonResponse(`{"lessons":[{"lessonId":"abcdef123456"}`)).toMatchObject({ ok: false, reason: "truncated-json" });
  });
  it("rejects reasoning-only output", () => {
    expect(parseLessonResponse("<think>the lessons are...</think>")).toMatchObject({ ok: false, reason: "reasoning-only" });
  });
  it("rejects schema-invalid cards", () => {
    expect(parseLessonResponse('{"lessons":[{"lessonId":"12345678","bad":true}]}')).toMatchObject({ ok: false, reason: "schema-invalid" });
  });
});

describe("validateLessonCard", () => {
  const input = { serverProfileId: "profile-a", taskFacts: FACTS };

  it("accepts a well-evidenced in-scope card", () => {
    expect(validateLessonCard(card(), input).verdict).toBe("acceptable");
  });
  it("rejects cross-profile cards", () => {
    expect(validateLessonCard(card({ serverProfileId: "profile-b" }), input)).toMatchObject({ verdict: "rejected" });
  });
  it("rejects fabricated evidence taskIds", () => {
    const validation = validateLessonCard(card({ evidence: [{ taskId: "ghost-task", outcome: "failed" }] }), input);
    expect(validation.verdict).toBe("rejected");
    expect(validation.reasons.some((r) => r.code === "EVIDENCE_TASK_UNKNOWN")).toBe(true);
  });
  it("rejects evidence outcome mismatch", () => {
    const validation = validateLessonCard(card({ evidence: [{ taskId: "task-3", outcome: "failed" }] }), input);
    expect(validation.reasons.some((r) => r.code === "EVIDENCE_OUTCOME_MISMATCH")).toBe(true);
  });
  it("rejects advice that weakens safety gates", () => {
    const validation = validateLessonCard(card({ advice: "Disable the policy guard before mining." }), input);
    expect(validation.verdict).toBe("rejected");
    expect(validation.reasons.some((r) => r.code === "ADVICE_UNSAFE")).toBe(true);
  });
  it("downgrades thin evidence to needs-reobservation, not rejected", () => {
    const validation = validateLessonCard(card({ evidence: [] }), input);
    expect(validation.verdict).toBe("needs-reobservation");
    expect(validation.reasons.some((r) => r.code === "EVIDENCE_THIN")).toBe(true);
  });
});

describe("FileLessonStore", () => {
  it("persists per profile with opaque fingerprint names and idempotent overwrite", () => {
    const dir = tempDir();
    const store = new FileLessonStore(dir);
    expect(store.save(card())).toBe(true);
    expect(store.save(card({ observedAtMs: NOW_MS + 5 }))).toBe(false); // same fingerprint → overwrite
    const listed = store.list("profile-a");
    expect(listed).toHaveLength(1);
    expect(listed[0]!.observedAtMs).toBe(NOW_MS + 5);
    expect(readdirSync(dir)).toContain("profile-a");
    expect(readdirSync(path.join(dir, "profile-a"))[0]).toMatch(/^[a-f0-9]{16}\.json$/);
    expect(store.list("profile-other")).toEqual([]);
  });
  it("fail-closes on residual secrets instead of writing", () => {
    const store = new FileLessonStore(tempDir());
    expect(() => store.save(card({ trigger: { goalPattern: "x", failureCodes: [`token=${"a".repeat(40)}`] } }))).toThrow(/SECRET_RESIDUE/);
  });
  it("skips corrupt files during list", () => {
    const dir = tempDir();
    const store = new FileLessonStore(dir);
    store.save(card());
    writeFileSync(path.join(dir, "profile-a", `${"0".repeat(16)}.json`), "{broken");
    expect(store.list("profile-a")).toHaveLength(1);
  });
  it("evicts oldest beyond the per-profile budget", () => {
    const dir = tempDir();
    const store = new FileLessonStore(dir, 3);
    for (let index = 0; index < 5; index++) {
      store.save(card({ advice: `advice variant ${index}`, observedAtMs: NOW_MS + index }));
    }
    const listed = store.list("profile-a");
    expect(listed).toHaveLength(3);
    const advices = listed.map((c) => c.advice);
    expect(advices).not.toContain("advice variant 0");
    expect(advices).not.toContain("advice variant 1");
  });
});

describe("askLessonReview + LessonReviewService", () => {
  it("saves acceptable cards and accounts rejected ones", async () => {
    const good = card();
    const bad = card({ advice: "bypass the anti-cheat gate", evidence: [{ taskId: "task-1", outcome: "failed" }] });
    const client = fakeClient(JSON.stringify({ lessons: [good, bad] }));
    const store = new FileLessonStore(tempDir());
    const result = await askLessonReview({ client, input: { serverProfileId: "profile-a", taskFacts: FACTS }, requestId: "req-1", nowMs: () => NOW_MS });
    expect(result.accounting).toMatchObject({ outcome: "saved", requestedCards: 2, acceptableCards: 1, rejectedCards: 1 });
    expect(result.savedCards).toHaveLength(1);
    let savedCount = 0;
    for (const lessonCard of result.savedCards) if (store.save(lessonCard)) savedCount++;
    expect(savedCount).toBe(1);
  });
  it("accounts request failures without throwing", async () => {
    const client: ModelClient = { complete: async () => { throw new Error("hub down"); } };
    const result = await askLessonReview({ client, input: { serverProfileId: "profile-a", taskFacts: FACTS }, requestId: "req-2" });
    expect(result.accounting).toMatchObject({ outcome: "request-failed" });
  });
  it("redacts goal text into the prompt", () => {
    const prompt = buildLessonReviewPrompt({
      serverProfileId: "profile-a",
      taskFacts: [{ ...FACTS[0]!, goal: "collect api_key=sk-live-secret123456789" }],
    });
    expect(prompt).not.toContain("sk-live-secret123456789");
    expect(prompt).toContain("[REDACTED]");
  });

  it("service: manual trigger runs once, cooldown dedupes, session-end fires on online→offline", async () => {
    const dir = tempDir();
    const store = new FileLessonStore(dir);
    const completeCalls: string[] = [];
    const client: ModelClient = {
      complete: async (request) => {
        completeCalls.push(request.requestId);
        return { text: JSON.stringify({ lessons: [card()] }), finishReason: "stop", clientLatencyMs: 5 };
      },
    };
    let clock = NOW_MS;
    const service = new LessonReviewService({
      client,
      store,
      taskFacts: async () => FACTS,
      now: () => clock,
      cooldownMs: 10_000,
    });
    expect(service.requestReview("profile-a", "manual")).toMatchObject({ queued: true });
    await waitUntil(() => completeCalls.length === 1);
    clock += 1_000;
    expect(service.requestReview("profile-a", "manual")).toMatchObject({ queued: false, reason: "cooldown" });
    // 会话结束翻沿：online→offline 触发；冷却内仍去重。
    service.noteConnectionState("bot-01", "profile-a", "online");
    service.noteConnectionState("bot-01", "profile-a", "offline");
    expect(completeCalls).toHaveLength(1);
    clock += 20_000;
    service.noteConnectionState("bot-02", "profile-a", "online");
    service.noteConnectionState("bot-02", "profile-a", "offline");
    await waitUntil(() => completeCalls.length === 2);
    expect(store.list("profile-a").length).toBeGreaterThanOrEqual(1);
  });

  it("service: no terminal facts → skipped without model call", async () => {
    const completeCalls: string[] = [];
    const service = new LessonReviewService({
      client: {
        complete: async (request) => {
          completeCalls.push(request.requestId);
          return { text: "{}", finishReason: "stop", clientLatencyMs: 5 };
        },
      },
      store: new FileLessonStore(tempDir()),
      taskFacts: async () => [],
    });
    expect(service.requestReview("profile-a", "manual")).toMatchObject({ queued: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(completeCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function fakeClient(text: string): ModelClient {
  return { complete: async () => ({ text, finishReason: "stop", clientLatencyMs: 5 }) };
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!condition()) throw new Error("waitUntil condition not met");
}
