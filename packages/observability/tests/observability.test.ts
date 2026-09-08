import { describe, expect, it } from "vitest";

import {
  InMemoryMetricRegistry,
  createStructuredLogger,
  type StructuredLogRecord,
} from "../src/index.js";

describe("structured observability", () => {
  it("always emits correlation fields and redacts sensitive values", () => {
    const records: StructuredLogRecord[] = [];
    const logger = createStructuredLogger({
      service: "test-service",
      instanceId: "test-instance",
      now: () => new Date("2026-07-20T09:00:00.000Z"),
      sink: (record) => records.push(record),
    });
    logger.warn("test_event", {
      traceId: "trace-01",
      botId: "_Miner",
      authorization: "Bearer should-not-appear",
      note: "line one\nBearer abcdefghijklmnopqrstuvwxyz012345",
      serverHost: "private.example",
      position: { x: 1, y: 64, z: 2 },
      nested: { password: "secret-value", safe: "visible" },
    });

    expect(records).toEqual([
      expect.objectContaining({
        timestamp: "2026-07-20T09:00:00.000Z",
        level: "warn",
        service: "test-service",
        instanceId: "test-instance",
        event: "test_event",
        traceId: "trace-01",
        taskId: null,
        botId: "_Miner",
        skillId: null,
        modelName: null,
        authorization: "[REDACTED]",
        note: "line one [REDACTED]",
        serverHost: "[REDACTED]",
        position: "[REDACTED]",
        nested: { password: "[REDACTED]", safe: "visible" },
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("should-not-appear");
    expect(JSON.stringify(records)).not.toContain("secret-value");
    expect(JSON.stringify(records)).not.toContain("private.example");
  });

  /**
   * 截断本身是对的——远端消息不该决定日志体积。这几条守的是"截断必须看得见"：
   * 静默丢尾会让一个被削短的数组和一个完整的数组长得一模一样，读日志的人
   * 数一遍名字就会得出"第 21 个技能没上报"的错误结论。真实踩到过一次:
   * coordinator 的技能目录日志写着 availableCount: 21，数组里只有 20 个名字。
   */
  function loggerWithSink(): {
    logger: ReturnType<typeof createStructuredLogger>;
    records: StructuredLogRecord[];
  } {
    const records: StructuredLogRecord[] = [];
    return {
      records,
      logger: createStructuredLogger({
        service: "test-service",
        instanceId: "test-instance",
        now: () => new Date("2026-07-20T09:00:00.000Z"),
        sink: (record) => records.push(record),
      }),
    };
  }

  it("marks a truncated array instead of dropping the tail silently", () => {
    const { logger, records } = loggerWithSink();
    const skills = Array.from({ length: 21 }, (_, index) => `skill.${index}`);

    logger.info("catalog_event", { availableCount: skills.length, skills });

    const logged = records[0]!.skills as string[];
    // 保留下来的部分照旧可读，末尾多一个标记说明"这张单子是短的"。
    expect(logged).toHaveLength(21);
    expect(logged.slice(0, 20)).toEqual(skills.slice(0, 20));
    expect(logged[20]).toBe("[+1 [TRUNCATED]]");
    // 关键的一条：计数和数组不再互相矛盾到能骗过读者。
    expect(records[0]!.availableCount).toBe(21);
    expect(JSON.stringify(records)).toContain("TRUNCATED");
  });

  it("leaves an array at the cap unmarked", () => {
    const { logger, records } = loggerWithSink();
    const skills = Array.from({ length: 20 }, (_, index) => `skill.${index}`);

    logger.info("catalog_event", { skills });

    // 刚好装下就不该加标记，否则完整的观测会被误读成不完整。
    expect(records[0]!.skills).toEqual(skills);
    expect(JSON.stringify(records)).not.toContain("TRUNCATED");
  });

  it("reports how many object keys and fields were dropped", () => {
    const { logger, records } = loggerWithSink();
    const wide = Object.fromEntries(
      Array.from({ length: 35 }, (_, index) => [`key${index}`, index]),
    );
    const manyFields = Object.fromEntries(
      Array.from({ length: 70 }, (_, index) => [`field${index}`, index]),
    );

    logger.info("wide_event", { wide, ...manyFields });

    expect((records[0]!.wide as Record<string, unknown>)["[TRUNCATED]"]).toBe(3);
    expect(records[0]!["[TRUNCATED]"]).toBe(7);
  });

  /**
   * 过度脱敏和脱敏不足是两种错，但只有前一种会安静地发生：日志里就写着
   * `[REDACTED]`，看起来像是保护生效了。真实踩到过一次：`plan_items` 重试记的
   * `disposition` 因为内含 `position` 被整个删掉，而那个字段正是"这次重试决定了
   * 什么"的唯一记录。
   */
  it("redacts sensitive key tokens without swallowing words that merely contain one", () => {
    const { logger, records } = loggerWithSink();

    logger.info("token_boundary_event", {
      disposition: "accepted",
      deposition: "visible",
      maxTokens: 512,
      position: { x: 1, y: 64, z: 2 },
      botPosition: { x: 1, y: 64, z: 2 },
      server_host: "private.example",
      serverAddress: "private.example",
      access_token: "secret-token-value",
      refreshToken: "secret-refresh-value",
      apiKey: "secret-key-value",
    });

    const record = records[0]!;
    // 诊断字段照旧可读——这是修复的目的。
    expect(record.disposition).toBe("accepted");
    expect(record.deposition).toBe("visible");
    // 真正的敏感键一个都不能漏，驼峰和下划线两种写法都要拦住。
    expect(record.position).toBe("[REDACTED]");
    expect(record.botPosition).toBe("[REDACTED]");
    expect(record.server_host).toBe("[REDACTED]");
    expect(record.serverAddress).toBe("[REDACTED]");
    expect(record.access_token).toBe("[REDACTED]");
    expect(record.refreshToken).toBe("[REDACTED]");
    expect(record.apiKey).toBe("[REDACTED]");
    // 独立的 token 计数宁可误删也不放过，方向上偏保守。
    expect(record.maxTokens).toBe("[REDACTED]");
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("private.example");
    expect(serialized).not.toContain("secret-token-value");
    expect(serialized).not.toContain("secret-refresh-value");
    expect(serialized).not.toContain("secret-key-value");
  });

  it("keeps bounded lifecycle counters with non-sensitive labels", () => {
    const metrics = new InMemoryMetricRegistry();
    metrics.increment("bot_connection_attempts_total", { bot_id: "worker-01" });
    metrics.increment("bot_connection_attempts_total", { bot_id: "worker-01" });
    metrics.increment("bot_disconnects_total", {
      bot_id: "worker-01",
      reason: "socket_closed",
    });
    expect(metrics.snapshot()).toEqual([
      {
        name: "bot_connection_attempts_total",
        value: 2,
        labels: { bot_id: "worker-01" },
      },
      {
        name: "bot_disconnects_total",
        value: 1,
        labels: { bot_id: "worker-01", reason: "socket_closed" },
      },
    ]);
    expect(() =>
      metrics.increment("bot_heartbeats_total", { access_token: "secret" }),
    ).toThrowError(/sensitive/u);
  });

  it("accumulates LLM usage and task completion totals", () => {
    const metrics = new InMemoryMetricRegistry();
    const botLabels = { bot_id: "worker-01" };

    metrics.increment("bot_llm_prompt_tokens_total", botLabels, 120);
    metrics.increment("bot_llm_prompt_tokens_total", botLabels, 30);
    metrics.increment("bot_llm_completion_tokens_total", botLabels, 45);
    metrics.increment("bot_llm_queue_time_ms_total", botLabels, 7);
    metrics.increment("bot_llm_execution_time_ms_total", botLabels, 93);
    metrics.increment("bot_llm_total_latency_ms_total", botLabels, 100);
    metrics.increment(
      "bot_task_completion_time_ms_total",
      { ...botLabels, outcome: "success" },
      350,
    );
    metrics.increment(
      "bot_task_completion_time_ms_total",
      { ...botLabels, outcome: "abort" },
      125,
    );

    const beforeRejectedZero = metrics.snapshot();
    expect(() =>
      metrics.increment("bot_llm_queue_time_ms_total", botLabels, 0),
    ).toThrowError(/positive safe integer/u);
    expect(metrics.snapshot()).toEqual(beforeRejectedZero);
    expect(metrics.snapshot()).toEqual([
      {
        name: "bot_llm_completion_tokens_total",
        value: 45,
        labels: botLabels,
      },
      {
        name: "bot_llm_execution_time_ms_total",
        value: 93,
        labels: botLabels,
      },
      {
        name: "bot_llm_prompt_tokens_total",
        value: 150,
        labels: botLabels,
      },
      {
        name: "bot_llm_queue_time_ms_total",
        value: 7,
        labels: botLabels,
      },
      {
        name: "bot_llm_total_latency_ms_total",
        value: 100,
        labels: botLabels,
      },
      {
        name: "bot_task_completion_time_ms_total",
        value: 125,
        labels: { bot_id: "worker-01", outcome: "abort" },
      },
      {
        name: "bot_task_completion_time_ms_total",
        value: 350,
        labels: { bot_id: "worker-01", outcome: "success" },
      },
    ]);
  });
});
