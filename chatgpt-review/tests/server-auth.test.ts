import { describe, expect, it, vi } from "vitest";

import {
  attachServerAuth,
  isLoginPrompt,
  isRegisterPrompt,
  isSuccessPrompt,
  resolveServerAuthPassword,
  serverAuthPasswordEnvVar,
  type ServerAuthConfig,
} from "../src/server-auth.js";

function fakeBot() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(listener);
    }),
    removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const list = listeners.get(event) ?? [];
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    }),
    chat: vi.fn(),
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
}

function config(password: string): ServerAuthConfig {
  return { password, promptTimeoutMs: 1_000, confirmTimeoutMs: 1_000 };
}

describe("server auth prompt detection", () => {
  it("recognizes common registration prompts", () => {
    expect(isRegisterPrompt("/register <password> <password>")).toBe(true);
    expect(isRegisterPrompt("Please register with /reg pass pass")).toBe(true);
    expect(isRegisterPrompt("请注册账号")).toBe(true);
    expect(isRegisterPrompt("You are already registered")).toBe(false);
  });

  it("recognizes login prompts", () => {
    expect(isLoginPrompt("Please login with /login <password>")).toBe(true);
    expect(isLoginPrompt("/l <pass> to login")).toBe(true);
    expect(isLoginPrompt("已经注册，请登录")).toBe(true);
  });

  it("recognizes success confirmations", () => {
    expect(isSuccessPrompt("Successfully logged in!")).toBe(true);
    expect(isSuccessPrompt("注册成功")).toBe(true);
  });
});

describe("password env var", () => {
  it("derives the env var name from botId", () => {
    expect(serverAuthPasswordEnvVar("studio-bot-01"))
      .toBe("STUDIO_BOT_AUTH_PASSWORD_STUDIO_BOT_01");
  });

  it("resolves from environment", () => {
    expect(
      resolveServerAuthPassword("studio-bot-01", {
        STUDIO_BOT_AUTH_PASSWORD_STUDIO_BOT_01: "secret123",
      }),
    ).toBe("secret123");
    expect(resolveServerAuthPassword("studio-bot-02", {})).toBe("");
  });
});

describe("attachServerAuth", () => {
  it("sends register on registration prompt", () => {
    const bot = fakeBot();
    const states: string[] = [];
    attachServerAuth(bot as never, config("pw123"), (s) => states.push(s));
    bot.emit("message", "Please register: /reg <pass> <pass>");
    expect(bot.chat).toHaveBeenCalledWith("/register pw123 pw123");
    expect(states).toContain("registering");
  });

  it("sends login on login prompt", () => {
    const bot = fakeBot();
    attachServerAuth(bot as never, config("pw123"));
    bot.emit("message", "Welcome back! /login <password>");
    expect(bot.chat).toHaveBeenCalledWith("/login pw123");
  });

  it("confirms authenticated on success message", () => {
    const bot = fakeBot();
    const states: string[] = [];
    attachServerAuth(bot as never, config("pw123"), (s) => states.push(s));
    bot.emit("message", "Please login: /l <pass>");
    bot.emit("message", "Successfully logged in!");
    expect(states).toContain("authenticated");
  });

  it("reports no-password failure without sending", () => {
    const bot = fakeBot();
    const states: string[] = [];
    attachServerAuth(bot as never, config(""), (s) => states.push(s));
    bot.emit("message", "Please register");
    expect(bot.chat).not.toHaveBeenCalled();
    expect(states).toContain("failed-no-password");
  });

  it("only attempts once per connection", () => {
    const bot = fakeBot();
    attachServerAuth(bot as never, config("pw123"));
    bot.emit("message", "Please login");
    bot.emit("message", "Please login again");
    expect(bot.chat).toHaveBeenCalledTimes(1);
  });
});
