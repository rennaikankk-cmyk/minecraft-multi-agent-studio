// P0-2 回归测试——认证安全缺陷

import { describe, expect, it, vi } from "vitest";

import {
  attachServerAuth,
  type ServerAuthConfig,
} from "../src/server-auth.js";

function fakeBot() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    on: vi.fn((event: string, listener: (...args: never[]) => void) => {
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

const CONF = (pw: string): ServerAuthConfig => ({
  password: pw,
  promptTimeoutMs: 1_000,
  confirmTimeoutMs: 1_000,
});

describe("P0-D22: no password leak in state detail", () => {
  it("register command detail must NOT contain the plaintext password (twice)", () => {
    const bot = fakeBot();
    const CANARY = "CANARY_SECRET_pw123xyz";
    const details: string[] = [];
    attachServerAuth(bot as never, CONF(CANARY), (_s, d) => details.push(d ?? ""));
    bot.emit("message", "Please register: /reg <pass> <pass>");

    // The command contains the password twice: /register pw pw
    // Both occurrences must be masked
    const allText = details.join(" ");
    expect(allText).not.toContain(CANARY);
    expect(allText).not.toContain("pw123xyz");
  });

  it("login command detail must NOT contain the plaintext password", () => {
    const bot = fakeBot();
    const CANARY = "CANARY_LOGIN_pw456";
    const details: string[] = [];
    attachServerAuth(bot as never, CONF(CANARY), (_s, d) => details.push(d ?? ""));
    bot.emit("message", "Please login: /l <pass>");
    const allText = details.join(" ");
    expect(allText).not.toContain(CANARY);
  });
});

describe("P0-D23: wrong password must be terminal, not auto-retry", () => {
  it("wrong password => state is failed-wrong-password (terminal)", () => {
    const bot = fakeBot();
    const states: string[] = [];
    attachServerAuth(bot as never, CONF("old_pw"), (s) => states.push(s));
    bot.emit("message", "Please login");
    bot.emit("message", "Wrong password!");
    expect(states[states.length - 1]).toBe("failed-wrong-password");
  });

  it("after wrong password, a new prompt must NOT trigger another attempt", () => {
    const bot = fakeBot();
    attachServerAuth(bot as never, CONF("old_pw"));
    bot.emit("message", "Please login");
    bot.emit("message", "Wrong password!");
    const chatCountAfterFailure = bot.chat.mock.calls.length;
    // New prompt arrives after failure — must NOT re-send
    bot.emit("message", "Please login: /login <pass>");
    expect(bot.chat.mock.calls.length).toBe(chatCountAfterFailure);
  });
});
