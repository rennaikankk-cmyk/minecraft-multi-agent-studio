import { describe, expect, it } from "vitest";

import { AICircuitBreaker, CircuitOpenError } from "../src/circuit-breaker.js";


describe("AICircuitBreaker", () => {
  it("opens after consecutive failures and fast-fails without side effects", () => {
    let clock = 1_000;
    const breaker = new AICircuitBreaker({ failureThreshold: 3, windowMs: 60_000, cooldownMs: 1_000, maxProbes: 1, now: () => clock });
    for (let i = 0; i < 3; i += 1) breaker.recordFailure(`boom-${i}`);
    expect(breaker.snapshot().state).toBe("open");
    expect(() => breaker.beforeCall()).toThrow(CircuitOpenError);
    expect(breaker.snapshot().rejectedCount).toBe(1);
  });

  it("half-open after cooldown: probe success closes, probe failure re-opens", () => {
    let clock = 1_000;
    const breaker = new AICircuitBreaker({ failureThreshold: 2, windowMs: 60_000, cooldownMs: 500, maxProbes: 1, now: () => clock });
    breaker.recordFailure("a");
    breaker.recordFailure("b");
    expect(breaker.snapshot().state).toBe("open");
    clock += 600; // 冷却结束
    breaker.beforeCall(); // 进入 half-open，占用唯一探测名额
    expect(breaker.snapshot().state).toBe("half-open");
    expect(() => breaker.beforeCall()).toThrow(CircuitOpenError); // 名额满
    breaker.recordFailure("probe-failed");
    expect(breaker.snapshot().state).toBe("open");
    clock += 600;
    breaker.beforeCall();
    breaker.recordSuccess();
    expect(breaker.snapshot().state).toBe("closed");
    expect(breaker.snapshot().consecutiveFailures).toBe(0);
  });

  it("failure window resets stale sequences", () => {
    let clock = 1_000;
    const breaker = new AICircuitBreaker({ failureThreshold: 3, windowMs: 1_000, cooldownMs: 500, now: () => clock });
    breaker.recordFailure("a");
    clock += 2_000; // 上一次失败出窗
    breaker.recordFailure("b");
    expect(breaker.snapshot().consecutiveFailures).toBe(1);
    expect(breaker.snapshot().state).toBe("closed");
  });
});
