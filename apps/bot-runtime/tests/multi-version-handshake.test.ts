import { once } from "node:events";

import mineflayer, { type Bot } from "mineflayer";
import { createServer, type Server } from "minecraft-protocol";
import { describe, expect, it } from "vitest";

const MATRIX = [
  { minecraftVersion: "1.8.8", protocolVersion: 47, majorVersion: "1.8" },
  { minecraftVersion: "1.12.2", protocolVersion: 340, majorVersion: "1.12" },
  { minecraftVersion: "1.16.5", protocolVersion: 754, majorVersion: "1.16" },
  { minecraftVersion: "1.21.11", protocolVersion: 774, majorVersion: "1.21" },
] as const;

async function closeServer(server: Server): Promise<void> {
  const closed = once(server, "close");
  server.close();
  await closed;
}

async function detectVersion(
  expected: (typeof MATRIX)[number],
): Promise<Readonly<Record<string, string | number>>> {
  const server = createServer({
    host: "127.0.0.1",
    port: 0,
    version: expected.minecraftVersion,
    "online-mode": false,
    kickTimeout: 2_000,
    checkTimeoutInterval: 100,
  });
  await once(server, "listening");
  const address = server.socketServer.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("The loopback protocol fixture did not expose a TCP port.");
  }

  let bot: Bot | null = null;
  try {
    bot = mineflayer.createBot({
      host: "127.0.0.1",
      port: address.port,
      username: "VersionProbe",
      auth: "offline",
      version: false,
      hideErrors: true,
      logErrors: false,
    });
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        once(bot, "inject_allowed"),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Mineflayer version detection timed out.")),
            5_000,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    return {
      minecraftVersion: bot.version,
      protocolVersion: bot.protocolVersion,
      majorVersion: bot.majorVersion,
    };
  } finally {
    // The fixture never sends a world/login packet; server.close terminates all
    // accepted sockets and leaves no connection or external process behind.
    bot?.on("error", () => undefined);
    await closeServer(server);
  }
}

describe("Mineflayer automatic multi-version handshake", () => {
  for (const expected of MATRIX) {
    it(`detects ${expected.minecraftVersion} from its loopback protocol`, async () => {
      await expect(detectVersion(expected)).resolves.toEqual(expected);
    });
  }
});
