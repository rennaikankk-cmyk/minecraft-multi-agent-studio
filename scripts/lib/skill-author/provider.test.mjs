// ---------------------------------------------------------------------------
// 模型接入测试：端点规则、档案读取的 fail-closed、以及**密钥绝不外泄**。
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  SkillAuthorProviderError,
  callChatCompletions,
  compatibleChatEndpoint,
  loadActiveAiProfile,
  probeModels,
  resolveModel,
  selectModel,
} from "./provider.mjs";

const SECRET = "sk-should-never-be-logged-0123456789";
const tempDirs = [];

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function runtimeWith(store) {
  const dir = mkdtempSync(path.join(tmpdir(), "skill-author-provider-"));
  tempDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  if (store !== undefined) {
    writeFileSync(path.join(dir, "ai-providers.json"), typeof store === "string" ? store : JSON.stringify(store), "utf8");
  }
  return dir;
}

function cloudStore(overrides = {}) {
  return {
    schemaVersion: "1.0",
    activeProfileId: "aip-aaa1",
    profiles: [
      {
        id: "aip-aaa1",
        name: "DeepSeek",
        type: "openai-compatible",
        baseUrl: "https://api.deepseek.com",
        model: "",
        apiKey: SECRET,
        ...overrides,
      },
    ],
  };
}

describe("compatibleChatEndpoint（与 ai-router 同规则）", () => {
  it("DeepSeek 官方 base（不带 /v1）补成 /v1/chat/completions", () => {
    assert.equal(compatibleChatEndpoint("https://api.deepseek.com"), "https://api.deepseek.com/v1/chat/completions");
    assert.equal(compatibleChatEndpoint("https://api.deepseek.com/"), "https://api.deepseek.com/v1/chat/completions");
  });

  it("已带 /v1 或已带完整路径时不重复拼接", () => {
    assert.equal(compatibleChatEndpoint("https://x.test/v1"), "https://x.test/v1/chat/completions");
    assert.equal(
      compatibleChatEndpoint("https://x.test/v1/chat/completions"),
      "https://x.test/v1/chat/completions",
    );
  });

  it("HTTP 仅限回环；非回环 HTTP、内嵌凭据、query/fragment、非法 URL 一律拒绝", () => {
    assert.equal(compatibleChatEndpoint("http://127.0.0.1:8001/v1"), "http://127.0.0.1:8001/v1/chat/completions");
    assert.equal(compatibleChatEndpoint("http://localhost:8001"), "http://localhost:8001/v1/chat/completions");
    for (const bad of [
      "http://api.deepseek.com",
      "https://user:pass@api.deepseek.com",
      "https://api.deepseek.com?x=1",
      "https://api.deepseek.com#frag",
      "not-a-url",
      "",
    ]) {
      assert.throws(() => compatibleChatEndpoint(bad), SkillAuthorProviderError, `${bad} 应当被拒`);
    }
  });
});

describe("loadActiveAiProfile", () => {
  it("读取已激活的云端档案", async () => {
    const root = runtimeWith(cloudStore());
    const profile = await loadActiveAiProfile(root);
    assert.equal(profile.type, "openai-compatible");
    assert.equal(profile.baseUrl, "https://api.deepseek.com");
    assert.equal(profile.apiKey, SECRET);
  });

  it("未配置/未激活/找不到/类型不符/缺密钥一律 fail-closed", async () => {
    await assert.rejects(() => loadActiveAiProfile(runtimeWith(undefined)), /AI_PROVIDER_NOT_CONFIGURED/u);
    await assert.rejects(() => loadActiveAiProfile(runtimeWith("not json")), /AI_PROVIDER_STORE_INVALID/u);
    await assert.rejects(
      () => loadActiveAiProfile(runtimeWith({ schemaVersion: "1.0", profiles: [] })),
      /AI_PROVIDER_NOT_ACTIVATED/u,
    );
    await assert.rejects(
      () => loadActiveAiProfile(runtimeWith({ schemaVersion: "1.0", activeProfileId: "aip-x", profiles: [] })),
      /AI_PROVIDER_NOT_FOUND/u,
    );
    await assert.rejects(
      () => loadActiveAiProfile(runtimeWith(cloudStore({ type: "local-ollama" }))),
      /AI_PROVIDER_TYPE_UNSUPPORTED/u,
    );
    await assert.rejects(
      () => loadActiveAiProfile(runtimeWith(cloudStore({ apiKey: "" }))),
      /AI_PROVIDER_KEY_MISSING/u,
    );
  });

  it("类型不符的错误信息里不含密钥", async () => {
    const root = runtimeWith(cloudStore({ type: "vllm" }));
    await assert.rejects(
      () => loadActiveAiProfile(root),
      (error) => {
        assert.equal(String(error.message).includes(SECRET), false, "错误信息绝不能包含密钥");
        return true;
      },
    );
  });
});

describe("selectModel", () => {
  it("显式配置优先，且必须真实存在（fail-closed，不回退 models[0]）", () => {
    assert.equal(selectModel(["deepseek-v4-pro", "deepseek-flash"], "deepseek-v4-pro"), "deepseek-v4-pro");
    assert.throws(() => selectModel(["deepseek-chat"], "deepseek-v4-pro"), /MODEL_NOT_AVAILABLE/u);
  });

  it("留空时按既有优先级自动选定；只有一个就用它；零个或多个无匹配则报错", () => {
    assert.equal(selectModel(["deepseek-v4-pro", "deepseek-flash"], ""), "deepseek-flash");
    assert.equal(selectModel(["some-model"], ""), "some-model");
    assert.throws(() => selectModel([], ""), /MODEL_NOT_AVAILABLE/u);
    assert.throws(() => selectModel(["a", "b"], ""), /MODEL_SELECTION_REQUIRED/u);
  });
});

describe("网络调用（注入 fetch）", () => {
  it("probeModels 打 /models 并带 Authorization", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ data: [{ id: "deepseek-flash" }, { id: "deepseek-chat" }] }) };
    };
    const models = await probeModels({ profile: { baseUrl: "https://api.deepseek.com", apiKey: SECRET }, fetchImpl });
    assert.deepEqual(models, ["deepseek-flash", "deepseek-chat"]);
    assert.equal(calls[0].url, "https://api.deepseek.com/v1/models");
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${SECRET}`);
  });

  it("callChatCompletions 打 /v1/chat/completions 并取回内容", async () => {
    let seen = null;
    const fetchImpl = async (url, init) => {
      seen = { url, body: JSON.parse(init.body) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: "{\"files\":[]}" } }] }) };
    };
    const content = await callChatCompletions({
      profile: { baseUrl: "https://api.deepseek.com", apiKey: SECRET },
      model: "deepseek-flash",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl,
    });
    assert.equal(content, "{\"files\":[]}");
    assert.equal(seen.url, "https://api.deepseek.com/v1/chat/completions");
    assert.equal(seen.body.model, "deepseek-flash");
  });

  it("非 2xx 与空内容都抛错，且错误信息不含密钥或响应体", async () => {
    const failFetch = async () => ({
      ok: false,
      status: 401,
      text: async () => `unauthorized key=${SECRET}`,
      json: async () => ({ error: SECRET }),
    });
    await assert.rejects(
      () =>
        callChatCompletions({
          profile: { baseUrl: "https://api.deepseek.com", apiKey: SECRET },
          model: "m",
          messages: [],
          fetchImpl: failFetch,
        }),
      (error) => {
        assert.match(error.message, /COMPLETION_FAILED/u);
        assert.equal(error.message.includes(SECRET), false, "不得回显响应体");
        return true;
      },
    );

    const emptyFetch = async () => ({ ok: true, json: async () => ({ choices: [] }) });
    await assert.rejects(
      () =>
        callChatCompletions({
          profile: { baseUrl: "https://api.deepseek.com", apiKey: SECRET },
          model: "m",
          messages: [],
          fetchImpl: emptyFetch,
        }),
      /COMPLETION_EMPTY/u,
    );
  });

  it("resolveModel 在模型留空时探测后选定", async () => {
    const events = [];
    const fetchImpl = async () => ({ ok: true, json: async () => ({ data: [{ id: "deepseek-chat" }, { id: "deepseek-flash" }] }) });
    const model = await resolveModel({
      profile: { baseUrl: "https://api.deepseek.com", apiKey: SECRET, model: "" },
      fetchImpl,
      logger: { info: (event) => events.push(event) },
    });
    assert.equal(model, "deepseek-flash");
    assert.deepEqual(events, ["skill_author_model_selected"]);
  });
});
