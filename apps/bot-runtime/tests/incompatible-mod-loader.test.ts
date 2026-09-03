// P1（2026-09-03）回归：INCOMPATIBLE_MOD_LOADER 真实事件序。
// 真实证据（runtime-data/canary-evidence/2026-09-03T05-41-34-685Z-simpfun-gray-bare-probe.json）：
//   connect → 2.2s 后 kicked("{\"text\":\"This server has mods that require FML/Forge
//   to be installed on the client. ...\"}") → end("socketClosed")
// Runtime 侧分裂路径（C 阶段实测）：部分 Forge 服 login 期直接断流——只发 end
// 不发 kick 包；P1 要求 end 文本含 FML/Forge 标记时合成为等价 PRE_LOGIN kick。
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Bot } from "mineflayer";

import { MineflayerBotClient } from "../src/mineflayer-client.js";
import type { BotDisconnectInfo } from "../src/client.js";

const SIMPFUN_KICK_JSON =
  '{"text":"This server has mods that require FML/Forge to be installed on the client. Contact your server admin for more details."}';

function makeBot() {
  const emitter = new EventEmitter();
  const bot = emitter as unknown as Bot;
  Object.assign(bot, {
    game: { dimension: "overworld" },
    inventory: { items: () => [], slots: [] },
    entity: null,
    world: {},
    experience: { points: 0 },
  });
  return { emitter, bot };
}

function captureDisconnect(client: MineflayerBotClient) {
  const captured: BotDisconnectInfo[] = [];
  client.setHandlers({
    onSpawn: () => undefined,
    onStateChanged: () => undefined,
    onDisconnected: (info) => captured.push(info),
  });
  return captured;
}

describe("INCOMPATIBLE_MOD_LOADER 真实事件序回归（simpfun 证据）", () => {
  it("路径 1（裸探针同序）：connect → kicked(FML JSON) → end(socketClosed)", () => {
    const { emitter, bot } = makeBot();
    const client = new MineflayerBotClient(bot, "auto", "simpfun-gray");
    const captured = captureDisconnect(client);

    // 真实事件序（时间戳见证据文件）
    emitter.emit("connect");
    emitter.emit("kicked", SIMPFUN_KICK_JSON);
    emitter.emit("end", "socketClosed");

    expect(captured).toHaveLength(1);
    const info = captured[0]!;
    expect(info.reason).toBe("kicked");
    expect(info.expected).toBe(false);
    expect(info.phase).toBe("PRE_LOGIN");
    expect(info.detail).toContain("FML/Forge");
  });

  it("路径 2（Runtime 分裂路径）：无 kick 包、end 文本含 FML 标记 → 合成等价 PRE_LOGIN kick", () => {
    const { emitter, bot } = makeBot();
    const client = new MineflayerBotClient(bot, "auto", "simpfun-gray");
    const captured = captureDisconnect(client);

    emitter.emit("connect");
    // 服务端在 login 期直接断流，disconnect 文本走 end 通道
    emitter.emit("end", "This server has mods that require FML/Forge to be installed on the client.");

    expect(captured).toHaveLength(1);
    const info = captured[0]!;
    expect(info.reason).toBe("kicked"); // 合成，不是 unknown
    expect(info.phase).toBe("PRE_LOGIN");
    expect(info.detail).toContain("FML/Forge");
  });

  it("路径 3（对照）：普通 end（无 FML 标记、无 kick）保持 unknown——不过度归类", () => {
    const { emitter, bot } = makeBot();
    const client = new MineflayerBotClient(bot, "auto", "simpfun-gray");
    const captured = captureDisconnect(client);

    emitter.emit("end", "socketClosed");

    expect(captured).toHaveLength(1);
    expect(captured[0]!.reason).not.toBe("kicked");
  });

  it("登录后 kicked：phase=POST_LOGIN（阶段证据字段正确分段）", () => {
    const { emitter, bot } = makeBot();
    const client = new MineflayerBotClient(bot, "auto", "simpfun-gray");
    const captured = captureDisconnect(client);

    emitter.emit("login");
    emitter.emit("kicked", SIMPFUN_KICK_JSON);
    emitter.emit("end", "socketClosed");

    expect(captured[0]!.phase).toBe("POST_LOGIN");
  });
});
