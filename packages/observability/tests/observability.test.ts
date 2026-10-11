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

  /**
   * 值级模式此前只有 4 条（Bearer、gho_、github_pat_、sk-），除 Bearer 外全是
   * 大小写敏感的 {20,} 长体。脱敏是"键名 + 值模式"两层，键名不可信时第二层
   * 就是唯一防线：同一个令牌换个键名（message/detail/reason/url/body）就原样
   * 落盘，短一点或大小写变体的直接放过。这里把同一批 secret 家族逐个考一遍。
   */
  it("redacts token families carried under a benign key", () => {
    const { logger, records } = loggerWithSink();
    const secrets = {
      githubClassic: "ghp_AFl0Y4Z1N0H9xKq0vB2cD3eF4gH5iJ6kL7mN8",
      githubOauthUpper: "GHO_AFl0Y4Z1N0H9xKq0vB2cD3eF4gH5iJ6kL7mN8",
      awsAccessKeyId: "AKIAIOSFODNN7EXAMPLE",
      slackBotToken: "xoxb-123456789012-abcdefghijklmnop",
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4JcuCA2QIHX8qE3FYk9crJstYPODehqK9s",
      shortProjectKey: "sk-abcdefghijklmnop",
    };

    logger.info("value_pattern_event", {
      message: `auth failed with ${secrets.githubClassic}`,
      detail: `oauth ${secrets.githubOauthUpper}`,
      reason: `aws rejected ${secrets.awsAccessKeyId}`,
      url: `https://hooks.slack.test/${secrets.slackBotToken}`,
      body: `expired jwt ${secrets.jwt}`,
      note: `using ${secrets.shortProjectKey}`,
    });

    const serialized = JSON.stringify(records);
    for (const secret of Object.values(secrets)) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("[REDACTED]");
  });

  /**
   * 自由文本里的 secret 以前完全不扫：`password=hunter2`、`api_key=...`、
   * `https://user:pass@host`、`Authorization: Basic ...` 都原样进日志。它们就
   * 藏在一个叫 reason/detail/url 的普通字符串里，键名那一层拦不住。
   */
  it("redacts free-text key/value secrets and URL credentials inside string values", () => {
    const { logger, records } = loggerWithSink();

    logger.info("free_text_event", {
      reason: "login rejected password=hunter2 while dialing",
      detail: "api_key=sk-abcdefghijklmnopqrstuvwx rejected",
      url: "https://operator:s3cr3t-panel@example.test/panel",
      body: "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    });

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(serialized).not.toContain("s3cr3t-panel");
    expect(serialized).not.toContain("dXNlcjpwYXNzd29yZA");
    expect(serialized).toContain("[REDACTED]");
  });

  /**
   * 截断顺序：sanitizeString 此前先 slice(0,500) 再跑敏感模式——超 500 字符
   * 的结构化令牌（大 claims 的 JWT、fine-grained PAT）被拦腰截断后脱离匹配
   * 形状（JWT 模式要求三段完整），~470 字符的真实令牌材料（可解码的 claims）
   * 直接落盘。现在先在预扫上限（16k）内脱敏、最后才截断展示长度。
   */
  it("redacts long (>500 char) tokens in full before the display truncation limit", () => {
    const { logger, records } = loggerWithSink();
    const longPayload = Buffer.from(
      JSON.stringify({ sub: "operator-secret-subject", notes: "x".repeat(600) }),
    ).toString("base64url");
    const longJwt = `eyJhbGciOiJIUzI1NiJ9.${longPayload}.dozjgNryP4JcuCA2QIHX8qE3FYk9crJstYPODehqK9s`;
    const longPat = `github_pat_${"A1b2c3d4e5f6g7h8".repeat(32)}`;
    expect(longJwt.length).toBeGreaterThan(500);
    expect(longPat.length).toBeGreaterThan(520);

    logger.info("long_secret_event", {
      body: `session rejected ${longJwt}`,
      note: `denied ${longPat}`,
    });

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("eyJhbGciOiJIUzI1NiJ9"); // JWT 头（截断必存的前缀）
    expect(serialized).not.toContain("operator-secret-subject"); // payload 内可解码声明
    expect(serialized).not.toContain("github_pat_");
    expect(serialized).toContain("[REDACTED]");
  });

  /**
   * 交叉复审 #6：先截后扫保证可见内容永不出自扫描窗口之外；唯一残差是
   * 跨窗口末端截断的令牌头段（部分形状、模式无法匹配），在前部内容被
   * 大量脱敏缩短后会被拉进可见区。从扫描串尾部剥除疑似令牌前缀游程后，
   * 跨界令牌的头段必须不可见；完全处于窗口之外的密钥也永不进入可见区。
   */
  it("contains no secret material pulled forward from the scan-window boundary", () => {
    const { logger, records } = loggerWithSink();
    // 少量超长可脱敏单元（脱敏后 ~15800 → ~24 字符），把跨界 JWT 的头段
    // 拉进最终可见的 500 字符内——这是"前移泄漏"的最小复现形态。
    const bulkUnit = `Bearer ${"a".repeat(7_900)}  `;
    const jwtPayload = Buffer.from(
      JSON.stringify({ sub: "boundary-secret-subject", notes: "y".repeat(300) }),
    ).toString("base64url");
    const straddlingJwt = `eyJhbGciOiJIUzI1NiJ9.${jwtPayload}.dozjgNryP4JcuCA2QIHX8qE3FYk9crJstYPODehqK9s`;
    logger.info("boundary_event", { body: bulkUnit.repeat(2) + straddlingJwt });

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("eyJhbGciOiJIUzI1NiJ9"); // 跨界 JWT 的头段
    expect(serialized).not.toContain("boundary-secret-subject");

    // 完全处于窗口之外的密钥（先截后扫不变量）。
    logger.info("beyond_event", { body: "b".repeat(17_000) + ` tail sk-${"c".repeat(30)}` });
    expect(JSON.stringify(records)).not.toContain("sk-cccc");
  });

  /**
   * 放宽值模式只能往"更保守"的方向走，不能顺手吃掉普通诊断文本：敏感词根出现
   * 在别的词里（disposition、maxTokens）、或敏感词后面跟的不是赋值/长串时，
   * 原文必须保留。过度脱敏是安静的错——日志里写着 [REDACTED]，看起来像保护生效。
   */
  it("keeps ordinary diagnostic text readable after broadening value patterns", () => {
    const { logger, records } = loggerWithSink();
    const note = "token budget exhausted; secret rotation not required; credential rotation skipped";

    logger.info("benign_text_event", {
      disposition: "accepted",
      detail: "position correction applied on retry 3",
      note,
      reason: "connection reset by peer",
    });

    expect(records[0]!.disposition).toBe("accepted");
    expect(records[0]!.detail).toBe("position correction applied on retry 3");
    expect(records[0]!.note).toBe(note);
    expect(records[0]!.reason).toBe("connection reset by peer");
  });

  /**
   * 值模式是模块级共享的 g 正则。带 g 的 test()/exec() 会把 lastIndex 推进到
   * 命中之后，下一次扫描就从中间起步——gap-bundle 刚修过同形状的 fail-open。
   * 这里连续写两次同一条 secret，锁住"共享 g 正则的状态不跨调用泄漏"
   * （replace 本身会复位 lastIndex，改回 test/exec 就会先在这里炸掉）。
   */
  it("keeps redacting on repeated writes (no shared lastIndex leak)", () => {
    const { logger, records } = loggerWithSink();

    logger.info("repeat_event", { reason: "password=hunter2" });
    logger.info("repeat_event", { reason: "password=hunter2" });

    expect(records).toHaveLength(2);
    expect(JSON.stringify(records[0])).not.toContain("hunter2");
    expect(JSON.stringify(records[1])).not.toContain("hunter2");
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
