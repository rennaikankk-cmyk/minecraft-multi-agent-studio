import { describe, expect, it } from "vitest";

import {
  TaskInfrastructureConfigError,
  parseIsolatedPostgresUrl,
  parseIsolatedRedisUrl,
  parseIsolatedTaskInfrastructureConfig,
} from "../src/infrastructure-config.js";

describe("isolated task infrastructure configuration", () => {
  it("accepts explicit loopback PostgreSQL and Redis URLs", () => {
    expect(
      parseIsolatedTaskInfrastructureConfig({
        postgresUrl:
          "postgresql://studio:local-test@127.0.0.1:5432/studio_tasks",
        redisUrl: "redis://127.0.0.1:6379/4",
        queueName: "studio_tasks_v1",
        queuePrefix: "studio_test_a1",
      }),
    ).toEqual({
      postgresUrl:
        "postgresql://studio:local-test@127.0.0.1:5432/studio_tasks",
      redisUrl: "redis://127.0.0.1:6379/4",
      queueName: "studio_tasks_v1",
      queuePrefix: "studio_test_a1",
    });
  });

  it.each([
    ["postgresql://studio@192.168.1.10/studio", "PostgreSQL"],
    ["postgresql://studio@example.com/studio", "PostgreSQL"],
    ["redis://10.0.0.4:6379/0", "Redis"],
    ["redis://example.com:6379/0", "Redis"],
  ])("rejects non-loopback %s URLs", (url, kind) => {
    const parse =
      kind === "PostgreSQL"
        ? parseIsolatedPostgresUrl
        : parseIsolatedRedisUrl;
    expect(() => parse(url)).toThrow(TaskInfrastructureConfigError);
  });

  it("rejects unknown fields and unsafe Redis database selectors", () => {
    expect(() =>
      parseIsolatedTaskInfrastructureConfig({
        postgresUrl: "postgresql://studio@127.0.0.1/studio",
        redisUrl: "redis://127.0.0.1:6379/16",
        queueName: "studio_tasks_v1",
        queuePrefix: "studio_test_a1",
        fallbackUrl: "redis://127.0.0.1:6380",
      }),
    ).toThrow();
    expect(() =>
      parseIsolatedRedisUrl("redis://127.0.0.1:6379/16"),
    ).toThrow(TaskInfrastructureConfigError);
    expect(() =>
      parseIsolatedRedisUrl("redis://127.0.0.1:6379/0?sentinel=unknown"),
    ).toThrow(TaskInfrastructureConfigError);
    expect(() =>
      parseIsolatedPostgresUrl(
        "postgresql://studio@127.0.0.1/studio?host=example.com",
      ),
    ).toThrow(TaskInfrastructureConfigError);
  });
});
