import { describe, expect, it } from "vitest";

import {
  REDACTED,
  containsUnredactedSecrets,
  redactSecrets,
  redactText,
  scanResidualSecrets,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// 包的导出面：redaction 必须导出最强的那一套
//
// gap-bundle 的 redactText/scanResidualSecrets 只有 3 条模式（键值/Bearer/
// GitHub 前缀），incidents.ts 的 redactSecrets/containsUnredactedSecrets 才是
// 递归抠 key + JWT + URL userinfo + 自由文本 key/value 的 fail-closed 版本
// （先 redact，再 secret scan，残留即拒绝导出）。以前 barrel 只导出前者，
// 调用方想用强版本只能深引 "../src/incidents.js"，等于把强实现挡在公共面之外。
// ---------------------------------------------------------------------------

describe("skills redaction export surface", () => {
  it("exposes the fail-closed redactor from incidents.ts", () => {
    expect(typeof redactSecrets).toBe("function");
    expect(typeof containsUnredactedSecrets).toBe("function");
    expect(REDACTED).toBe("[REDACTED]");

    // 只有强版本才认得的家族：JWT 与 AWS access key id。
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4JcuCA2QIHX8qE3FYk9crJstYPODehqK9s";
    expect(redactSecrets(jwt) as string).not.toContain("eyJhbGci");
    expect(containsUnredactedSecrets("aws AKIAIOSFODNN7EXAMPLE")).toBe(true);
    expect(containsUnredactedSecrets("clean text")).toBe(false);
  });

  it("keeps the existing gap-bundle redactor exported for backward compatibility", () => {
    // apps/coordinator 的 planner-memory / lesson-store / lesson-review 三个
    // 调用方直接 import 这两个名字；barrel 只能加，不能换。
    expect(typeof redactText).toBe("function");
    expect(typeof scanResidualSecrets).toBe("function");
    expect(redactText("api_key=abc123secret")).toContain("[REDACTED]");
    expect(scanResidualSecrets("hello world")).toBe(true);
  });
});
