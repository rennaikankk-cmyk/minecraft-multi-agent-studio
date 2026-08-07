import { describe, expect, it } from "vitest";

import {
  CoordinatorLinkConfigError,
  loadCoordinatorLinkConfig,
} from "../src/index.js";

const SECRET = "control-link-client-test-secret-000000000000000001";

describe("Control API Coordinator Link configuration", () => {
  it("loads only an explicit loopback link with required credentials", () => {
    expect(
      loadCoordinatorLinkConfig({
        CONTROL_API_COORDINATOR_LINK_URL:
          "ws://127.0.0.1:3221/v1/control-link",
        CONTROL_API_COORDINATOR_LINK_CLIENT_ID: "control-api-main",
        CONTROL_API_COORDINATOR_LINK_KEY_ID: "control-link-key-01",
        CONTROL_API_COORDINATOR_LINK_SECRET: SECRET,
      }),
    ).toMatchObject({
      url: "ws://127.0.0.1:3221/v1/control-link",
      clientId: "control-api-main",
      keyId: "control-link-key-01",
      secret: SECRET,
      livenessTimeoutMs: 75_000,
      stopTimeoutMs: 17_000,
    });
  });

  it("rejects non-loopback, URL credentials, and missing secrets", () => {
    expect(() =>
      loadCoordinatorLinkConfig({
        CONTROL_API_COORDINATOR_LINK_URL:
          "ws://example.com:3221/v1/control-link",
        CONTROL_API_COORDINATOR_LINK_CLIENT_ID: "control-api-main",
        CONTROL_API_COORDINATOR_LINK_KEY_ID: "control-link-key-01",
        CONTROL_API_COORDINATOR_LINK_SECRET: SECRET,
      }),
    ).toThrowError(CoordinatorLinkConfigError);
    expect(() =>
      loadCoordinatorLinkConfig({
        CONTROL_API_COORDINATOR_LINK_URL:
          "ws://user:secret@127.0.0.1:3221/v1/control-link",
        CONTROL_API_COORDINATOR_LINK_CLIENT_ID: "control-api-main",
        CONTROL_API_COORDINATOR_LINK_KEY_ID: "control-link-key-01",
        CONTROL_API_COORDINATOR_LINK_SECRET: SECRET,
      }),
    ).toThrowError(CoordinatorLinkConfigError);
    expect(() => loadCoordinatorLinkConfig({})).toThrowError(
      expect.objectContaining({ code: "COORDINATOR_LINK_URL_REQUIRED" }),
    );
  });
});
