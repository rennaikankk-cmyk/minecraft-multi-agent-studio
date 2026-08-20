import { randomUUID } from "node:crypto";

import type { AIRequest, AITaskType } from "../src/index.js";

export function request(
  overrides: Partial<AIRequest> = {},
): AIRequest {
  return {
    requestId: randomUUID(),
    traceId: `trace-${randomUUID()}`,
    botId: "bot-1",
    taskType: "planner",
    priority: 30,
    timestamp: new Date().toISOString(),
    stateVersion: 1,
    taskVersion: 1,
    prompt: "Choose one safe skill.",
    maxTokens: 100,
    temperature: 0,
    timeoutMs: 1_000,
    ...overrides,
  } as AIRequest;
}

export function response(content = "ok") {
  return {
    content,
    model: "mock-model",
    usage: { promptTokens: 10, completionTokens: 2 },
  } as const;
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function typedTask(taskType: AITaskType): AITaskType {
  return taskType;
}
