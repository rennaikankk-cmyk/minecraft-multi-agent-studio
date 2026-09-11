import { describe, expect, it } from "vitest";

import {
  redactEventDetail,
  RuntimeEventBuffer,
  RUNTIME_EVENT_KINDS,
} from "../src/runtime-event-buffer.js";

function fakeClocks(startMs = 1_000) {
  let mono = startMs;
  let wall = Date.parse("2026-09-01T12:00:00.000Z");
  return {
    now: () => new Date(wall),
    monotonicNow: () => mono,
    advance(deltaMs: number) {
      mono += deltaMs;
      wall += deltaMs;
    },
  };
}

describe("RuntimeEventBuffer bounds", () => {
  it("enforces the maxEvents bound and counts dropped entries", () => {
    const clock = fakeClocks();
    const buffer = new RuntimeEventBuffer({ maxEvents: 8, now: clock.now, monotonicNow: clock.monotonicNow });
    for (let i = 0; i < 20; i += 1) {
      clock.advance(3_000); // 超过 coalesce 窗口，逐条独立
      buffer.append({ kind: "material_progress", source: "navigation", detail: `d=${i}` });
    }
    const snapshot = buffer.snapshot({ windowMs: 10 * 60_000, maxEvents: 60 });
    expect(snapshot.totalBuffered).toBe(8);
    expect(snapshot.droppedCount).toBe(12);
  });

  it("prunes entries older than maxAgeMs", () => {
    const clock = fakeClocks();
    const buffer = new RuntimeEventBuffer({ maxEvents: 64, maxAgeMs: 30_000, now: clock.now, monotonicNow: clock.monotonicNow });
    buffer.append({ kind: "skill_started", source: "skill", detail: "old" });
    clock.advance(60_000);
    buffer.append({ kind: "skill_result", source: "skill", detail: "new" });
    const snapshot = buffer.snapshot({ windowMs: 10 * 60_000, maxEvents: 60 });
    expect(snapshot.events.map((event) => event.kind)).toEqual(["skill_result"]);
    expect(snapshot.droppedCount).toBe(1);
  });

  it("coalesces high-frequency same-kind events within the window instead of growing", () => {
    const clock = fakeClocks();
    const buffer = new RuntimeEventBuffer({ coalesceWindowMs: 2_000, now: clock.now, monotonicNow: clock.monotonicNow });
    for (let i = 0; i < 50; i += 1) {
      clock.advance(100);
      buffer.append({ kind: "material_progress", source: "navigation", correlationId: "g1", detail: `dist=${100 - i}` });
    }
    const snapshot = buffer.snapshot({ windowMs: 60_000, maxEvents: 60 });
    expect(snapshot.totalBuffered).toBe(1);
    expect(snapshot.coalescedCount).toBe(49);
    expect(snapshot.events[0]?.detail).toContain("x50");
  });

  it("keeps events with a different correlationId separate", () => {
    const clock = fakeClocks();
    const buffer = new RuntimeEventBuffer({ now: clock.now, monotonicNow: clock.monotonicNow });
    buffer.append({ kind: "material_progress", source: "navigation", correlationId: "a", detail: "1" });
    buffer.append({ kind: "material_progress", source: "navigation", correlationId: "b", detail: "2" });
    expect(buffer.snapshot({ windowMs: 60_000, maxEvents: 60 }).totalBuffered).toBe(2);
  });
});

describe("RuntimeEventBuffer ordering and clocks", () => {
  it("preserves append order and pairs wall clock with the monotonic clock", () => {
    const clock = fakeClocks();
    const buffer = new RuntimeEventBuffer({ now: clock.now, monotonicNow: clock.monotonicNow });
    buffer.append({ kind: "skill_started", source: "skill" });
    clock.advance(1_500);
    buffer.append({ kind: "movement_started", source: "navigation" });
    const events = buffer.snapshot({ windowMs: 60_000, maxEvents: 60 }).events;
    expect(events.map((event) => event.kind)).toEqual(["skill_started", "movement_started"]);
    expect(events[0]?.at).toBe("2026-09-01T12:00:00.000Z");
    expect(events[1]?.at).toBe("2026-09-01T12:00:01.500Z");
  });
});

describe("RuntimeEventBuffer snapshot semantics", () => {
  it("limits the window by age and marks truncation with metadata", () => {
    const clock = fakeClocks();
    const buffer = new RuntimeEventBuffer({ now: clock.now, monotonicNow: clock.monotonicNow });
    for (let i = 0; i < 10; i += 1) {
      clock.advance(2_500);
      buffer.append({ kind: "no_progress_warning", source: "watchdog", correlationId: `c${i}`, detail: `age=${(i + 1) * 2.5}s` });
    }
    const snapshot = buffer.snapshot({ windowMs: 10_000, maxEvents: 3 });
    expect(snapshot.events.length).toBe(3);
    expect(snapshot.truncated).toBe(true);
    // 最近 3 条（c7..c9），且每条带 correlation 标注
    expect(snapshot.events[2]?.detail).toContain("corr=c9");
  });

  it("returns a defensive copy that does not mutate the buffer", () => {
    const clock = fakeClocks();
    const buffer = new RuntimeEventBuffer({ now: clock.now, monotonicNow: clock.monotonicNow });
    buffer.append({ kind: "watchdog_triggered", source: "watchdog", detail: "stuck" });
    const first = buffer.snapshot({ windowMs: 60_000, maxEvents: 60 });
    const second = buffer.snapshot({ windowMs: 60_000, maxEvents: 60 });
    expect(first.events).toEqual(second.events);
    expect(first.events).not.toBe(second.events);
  });
});

describe("RuntimeEventBuffer redaction and untrusted text", () => {
  it("redacts secret-shaped tokens in event detail", () => {
    expect(redactEventDetail("api_key=abcdefghijklmnopqrstuvwxyz123456")).toContain("[REDACTED]");
    expect(redactEventDetail("Authorization: Bearer aaaaaaaaaaaaaaaaaaaaaaaa")).toContain("[REDACTED]");
    expect(redactEventDetail("dist=12.3 pathResets=2")).not.toContain("[REDACTED]");
  });

  it("substitutes the key name instead of emitting a literal $1", () => {
    // 回归：SECRETISH 的键名组曾写作非捕获组 (?:...)，于是替换串里的 $1 原样
    // 输出为字面量 "$1=[REDACTED]"。上面那条既有用例只断言 toContain("[REDACTED]")，
    // 对两种写法都成立，因此掩盖了这个缺陷——本条断言键名真的被代入。
    const redacted = redactEventDetail("api_key=abcdefghijklmnopqrstuvwxyz123456");
    expect(redacted).not.toContain("$1");
    expect(redacted).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(redacted).toBe("api_key=[REDACTED]");

    const bearer = redactEventDetail("Authorization: Bearer aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(bearer).not.toContain("$1");
    expect(bearer).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("truncates pathological long tokens", () => {
    const long = "x".repeat(300);
    expect(redactEventDetail(long)?.length ?? 0).toBeLessThan(120);
  });

  it("marks untrusted external text explicitly", () => {
    const clock = fakeClocks();
    const buffer = new RuntimeEventBuffer({ now: clock.now, monotonicNow: clock.monotonicNow });
    buffer.append({
      kind: "connection_event",
      source: "connection",
      detail: "kick reason: You are banned",
      untrustedExternalText: true,
    });
    const events = buffer.snapshot({ windowMs: 60_000, maxEvents: 60 }).events;
    expect(events[0]?.detail).toContain("UNTRUSTED_EXTERNAL_TEXT");
  });
});

describe("runtime event vocabulary", () => {
  it("keeps the incident timeline vocabulary stable (frontend/export rely on it)", () => {
    expect(RUNTIME_EVENT_KINDS).toContain("watchdog_triggered");
    expect(RUNTIME_EVENT_KINDS).toContain("material_progress");
    expect(RUNTIME_EVENT_KINDS).toContain("path_recalculated");
    expect(RUNTIME_EVENT_KINDS).toContain("skill_started");
    expect(RUNTIME_EVENT_KINDS).toContain("incident_report_enqueued");
    expect(RUNTIME_EVENT_KINDS).toContain("incident_report_sent");
  });
});
