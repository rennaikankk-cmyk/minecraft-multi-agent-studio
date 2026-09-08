import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AuthCredentialStore,
  generatePassword,
} from "../src/auth-store.js";
import {
  attachServerAuth,
  type ServerAuthConfig,
} from "../src/server-auth.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "studio-auth-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function fakeBot() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(listener);
    }),
    removeListener: vi.fn(),
    chat: vi.fn(),
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
}

describe("AuthCredentialStore", () => {
  it("isolates game usernames and supports Windows device names across restart", () => {
    for (const botId of ["CON", "AUX", "_Resident_1"]) {
      new AuthCredentialStore(botId, tempDir).persist("example.test", 25565, `fixture-${botId}`);
    }
    for (const botId of ["CON", "AUX", "_Resident_1"]) {
      expect(new AuthCredentialStore(botId, tempDir).find("example.test", 25565)?.password).toBe(`fixture-${botId}`);
      expect(new AuthCredentialStore(botId, tempDir).find("example.test", 25566)).toBeNull();
    }
  });

  it("generates a password on first use and persists after registration", () => {
    const store = new AuthCredentialStore("studio-bot-01", tempDir);
    const first = store.getOrCreate("example.com", 25565);
    expect(first.isNew).toBe(true);
    expect(first.password).toHaveLength(16);
    // Not persisted yet (registration hasn't been confirmed)
    expect(store.find("example.com", 25565)).toBeNull();
    // Registration succeeds → persist
    store.persist("example.com", 25565, first.password);
    expect(store.find("example.com", 25565)?.password).toBe(first.password);
    // Next join: returns the same password, not new
    const second = store.getOrCreate("example.com", 25565);
    expect(second.isNew).toBe(false);
    expect(second.password).toBe(first.password);
  });

  it("isolates credentials per server (same bot, different servers)", () => {
    const store = new AuthCredentialStore("studio-bot-01", tempDir);
    store.persist("server-a.com", 25565, "passA");
    store.persist("server-b.com", 25565, "passB");
    expect(store.find("server-a.com", 25565)?.password).toBe("passA");
    expect(store.find("server-b.com", 25565)?.password).toBe("passB");
  });

  it("survives store recreation (file persistence)", () => {
    const store1 = new AuthCredentialStore("studio-bot-01", tempDir);
    store1.persist("example.com", 25565, "persisted-pw");
    const store2 = new AuthCredentialStore("studio-bot-01", tempDir);
    expect(store2.find("example.com", 25565)?.password).toBe("persisted-pw");
  });

  it("forget removes the credential", () => {
    const store = new AuthCredentialStore("studio-bot-01", tempDir);
    store.persist("example.com", 25565, "to-delete");
    store.forget("example.com", 25565);
    expect(store.find("example.com", 25565)).toBeNull();
  });

  it("writes the credential file with tight permissions", () => {
    const store = new AuthCredentialStore("studio-bot-01", tempDir);
    store.persist("example.com", 25565, "secret");
    const file = path.join(tempDir, "studio-bot-01.json");
    expect(existsSync(file)).toBe(true);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.schemaVersion).toBe("1.0");
    expect(raw.credentials[0].password).toBe("secret");
  });
});

describe("generatePassword", () => {
  it("produces unique 16-char passwords from a safe alphabet", () => {
    const pw1 = generatePassword();
    const pw2 = generatePassword();
    expect(pw1).toHaveLength(16);
    expect(pw1).not.toBe(pw2);
    expect(pw1).toMatch(/^[A-HJ-NP-Za-hj-km-np-z2-9]+$/u); // no ambiguous chars
  });
});

describe("attachServerAuth with store (full-auto flow)", () => {
  function storeConfig(store: AuthCredentialStore): ServerAuthConfig {
    return {
      store: {
        getOrCreate: (h, p) => store.getOrCreate(h, p),
        persist: (h, p, pw) => store.persist(h, p, pw),
        forget: (h, p) => store.forget(h, p),
      },
      serverHost: "example.com",
      serverPort: 25565,
      promptTimeoutMs: 1_000,
      confirmTimeoutMs: 1_000,
    };
  }

  it("registers with a generated password, then persists on success", () => {
    const bot = fakeBot();
    const store = new AuthCredentialStore("bot-01", tempDir);
    attachServerAuth(bot as never, storeConfig(store));
    // Server asks for registration
    bot.emit("message", "Please register: /reg <pass> <pass>");
    expect(bot.chat).toHaveBeenCalledTimes(1);
    const command = bot.chat.mock.calls[0]![0] as string;
    expect(command).toMatch(/^\/register \S{16} \S{16}$/u);
    const password = command.split(" ")[1]!;
    // Server confirms
    bot.emit("message", "Successfully registered!");
    // Password persisted
    expect(store.find("example.com", 25565)?.password).toBe(password);
  });

  it("logs in with the stored password on the next join", () => {
    const bot = fakeBot();
    const store = new AuthCredentialStore("bot-01", tempDir);
    store.persist("example.com", 25565, "known-password");
    attachServerAuth(bot as never, storeConfig(store));
    bot.emit("message", "Welcome back! /login <password>");
    expect(bot.chat).toHaveBeenCalledWith("/login known-password");
  });

  it("forgets the stored credential on wrong password (desync recovery)", () => {
    const bot = fakeBot();
    const store = new AuthCredentialStore("bot-01", tempDir);
    store.persist("example.com", 25565, "stale-password");
    attachServerAuth(bot as never, storeConfig(store));
    bot.emit("message", "Please login");
    bot.emit("message", "Wrong password!");
    // Stored credential deleted so next join can re-register
    expect(store.find("example.com", 25565)).toBeNull();
  });
});
