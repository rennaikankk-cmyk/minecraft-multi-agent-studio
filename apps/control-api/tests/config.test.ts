import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ControlApiConfigError, loadControlApiConfig } from "../src/index.js";

const TOKEN = "control-api-test-token-00000000000001";
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");

describe("Control API configuration", () => {
  it("loads a strict loopback configuration containing only token hashes", () => {
    const config = loadControlApiConfig({
      CONTROL_API_HOST: "127.0.0.1",
      CONTROL_API_PORT: "3210",
      CONTROL_API_AUTH_JSON: JSON.stringify([
        {
          subject: "viewer-01",
          tokenSha256: TOKEN_HASH,
          permissions: ["bot.read"],
        },
      ]),
    });

    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 3210,
      principals: [{ subject: "viewer-01", tokenSha256: TOKEN_HASH }],
    });
  });

  it("rejects missing authentication and non-loopback binding", () => {
    expect(() => loadControlApiConfig({})).toThrowError(ControlApiConfigError);
    expect(() =>
      loadControlApiConfig({
        CONTROL_API_HOST: "0.0.0.0",
        CONTROL_API_AUTH_JSON: "[]",
      }),
    ).toThrowError(expect.objectContaining({ code: "CONTROL_API_CONFIG_INVALID" }));
  });

  it("rejects plaintext token fields and unknown permissions", () => {
    expect(() =>
      loadControlApiConfig({
        CONTROL_API_AUTH_JSON: JSON.stringify([
          {
            subject: "viewer-01",
            token: TOKEN,
            tokenSha256: TOKEN_HASH,
            permissions: ["bot.read"],
          },
        ]),
      }),
    ).toThrowError(ControlApiConfigError);
    expect(() =>
      loadControlApiConfig({
        CONTROL_API_AUTH_JSON: JSON.stringify([
          {
            subject: "viewer-01",
            tokenSha256: TOKEN_HASH,
            permissions: ["bot.admin"],
          },
        ]),
      }),
    ).toThrowError(ControlApiConfigError);
  });
});
