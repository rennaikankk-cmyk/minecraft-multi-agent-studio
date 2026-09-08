import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { managedCredentialEnvNames, resolveManagedGameIdentity } from "./managed-game-identity.mjs";

const environment = { STUDIO_BOT_EMAIL_ACCOUNT_ONE: "private@example.invalid", STUDIO_BOT_PASSWORD_ACCOUNT_ONE: "private-password" };
const input = { auth: "online", accountRef: "account-one", username: "UntrustedAlias" };
const uuid = "069A79F4-44E9-4726-A5BE-FCA90E38AAF5";
const fake = (profile = { name: "Verified_Player", id: uuid }) => ({
  environment,
  createAuthflow: () => ({ getMinecraftJavaToken: async () => ({ profile, token: "private-access-token" }) }),
});

test("offline username is the BotID and never starts Microsoft authentication", async () => {
  let called = false;
  assert.deepEqual(await resolveManagedGameIdentity({ username: "Offline_Bot" }, { createAuthflow: () => { called = true; } }),
    { auth: "offline", username: "Offline_Bot", botId: "Offline_Bot" });
  assert.equal(called, false);
  for (const username of ["a", "name with space", "../example", "longer_than_16_characters"]) {
    await assert.rejects(resolveManagedGameIdentity({ username }), { managerCode: "INVALID_REQUEST" });
  }
});

test("online BotID comes from authenticated Java profile, never UI alias or account reference", async () => {
  let observed;
  const result = await resolveManagedGameIdentity(input, {
    environment,
    createAuthflow: ({ email, password, signal }) => {
      assert.equal(email, environment.STUDIO_BOT_EMAIL_ACCOUNT_ONE);
      assert.equal(password, environment.STUDIO_BOT_PASSWORD_ACCOUNT_ONE);
      assert.equal(signal.aborted, false);
      return { getMinecraftJavaToken: async (options) => { observed = options; return { profile: { name: "Verified_Player", id: uuid }, token: "secret-token" }; } };
    },
  });
  assert.deepEqual(observed, { fetchProfile: true });
  assert.deepEqual(result, { auth: "online", botId: "Verified_Player", username: "Verified_Player", gameProfileId: "069a79f444e94726a5befca90e38aaf5", accountRef: "account-one" });
  assert.doesNotMatch(JSON.stringify(result), /private|secret-token|UntrustedAlias/u);
});

test("online creation requires controlled credential reference and complete backend credentials", async () => {
  for (const accountRef of [undefined, "person@example.invalid", "../account", "", "account with space"]) {
    await assert.rejects(resolveManagedGameIdentity({ ...input, accountRef }, fake()), { managerCode: "INVALID_REQUEST" });
  }
  for (const env of [{}, { ...environment, STUDIO_BOT_PASSWORD_ACCOUNT_ONE: "" }, { ...environment, STUDIO_BOT_EMAIL_ACCOUNT_ONE: "bad-email" }]) {
    let called = false;
    await assert.rejects(resolveManagedGameIdentity(input, { environment: env, createAuthflow: () => { called = true; } }), { managerCode: "AUTH_REQUIRED" });
    assert.equal(called, false);
  }
  assert.deepEqual(managedCredentialEnvNames("account-one"), { email: "STUDIO_BOT_EMAIL_ACCOUNT_ONE", password: "STUDIO_BOT_PASSWORD_ACCOUNT_ONE" });
});

test("missing and invalid upstream profiles fail closed without allocating identity", async () => {
  for (const profile of [null, {}, { name: "Bad Name", id: uuid }, { name: "ValidName", id: "not-a-uuid" }, { name: "ValidName", id: uuid, error: "sensitive-detail" }]) {
    await assert.rejects(resolveManagedGameIdentity(input, fake(profile)), { managerCode: "AUTH_REQUIRED", httpStatus: 401 });
  }
});

test("upstream authentication errors never disclose credentials or tokens, including error causes", async () => {
  const leaked = new Error("private@example.invalid private-password private-access-token");
  await assert.rejects(resolveManagedGameIdentity(input, {
    environment,
    createAuthflow: () => ({ getMinecraftJavaToken: async () => { throw leaked; } }),
  }), (error) => {
    assert.equal(error.managerCode, "AUTH_REQUIRED");
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /private@example|private-password|private-access-token/u);
    return true;
  });
});

test("upstream errors cannot impersonate safe timeout errors", async () => {
  await assert.rejects(resolveManagedGameIdentity(input, {
    environment,
    createAuthflow: () => ({ getMinecraftJavaToken: async () => { throw Object.assign(new Error("正版身份验证超时 private-password"), { managerCode: "AUTH_REQUIRED", httpStatus: 401 }); } }),
  }), (error) => !String(error).includes("private-password"));
});

test("identity verification times out and aborts before any late profile can bind an identity", async () => {
  let signal;
  await assert.rejects(resolveManagedGameIdentity(input, {
    environment, timeoutMs: 5,
    createAuthflow: (options) => { signal = options.signal; return { getMinecraftJavaToken: () => new Promise(() => {}) }; },
  }), { managerCode: "AUTH_REQUIRED", httpStatus: 401 });
  assert.equal(signal.aborted, true);
});

test("unknown auth modes fail closed", async () => {
  await assert.rejects(resolveManagedGameIdentity({ ...input, auth: "microsoft" }, fake()), { managerCode: "INVALID_REQUEST" });
});

test("packaged resolver starts a real worker with a bundled provider and suppresses dependency diagnostics", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "studio-identity-worker-"));
  try {
    const lib = path.join(temporary, "scripts", "lib");
    await mkdir(lib, { recursive: true });
    const entry = path.join(lib, "managed-game-identity.mjs");
    await copyFile(new URL("./managed-game-identity.mjs", import.meta.url), entry);
    // The upstream fixture guarantees that this integration performs no network
    // requests, while exercising the actual packaged-module lookup and worker.
    await writeFile(path.join(lib, "prismarine-auth.cjs"), `
      exports.Titles = { MinecraftNintendoSwitch: "fixture-title" };
      exports.Authflow = class {
        constructor(email, cache, options) {
          if (email !== "private@example.invalid" || options.password !== "private-password" || typeof cache !== "function") throw Error("invalid fixture credentials");
        }
        async getMinecraftJavaToken(options) {
          if (!options.fetchProfile) throw Error("profile was not requested");
          console.log("private-password private-access-token");
          console.error("private@example.invalid");
          return { profile: { name: "_Verified", id: "069a79f444e94726a5befca90e38aaf5" }, token: "private-access-token" };
        }
      };
    `);
    const source = `const { resolveManagedGameIdentity } = await import(${JSON.stringify(pathToFileURL(entry).href)}); process.stdout.write(JSON.stringify(await resolveManagedGameIdentity(${JSON.stringify(input)})));`;
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", source], {
      env: { ...process.env, ...environment, STUDIO_SEA_BUNDLE: "1" }, timeout: 10_000,
    });
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), { auth: "online", botId: "_Verified", username: "_Verified", gameProfileId: "069a79f444e94726a5befca90e38aaf5", accountRef: "account-one" });
    assert.doesNotMatch(stdout, /private-password|private-access-token|private@example/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
