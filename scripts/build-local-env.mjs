import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

const dashboardToken = randomBytes(32).toString("hex");
const controlLinkSecret = randomBytes(32).toString("hex");
const runtimeLinkSecret = randomBytes(32).toString("hex");
const BOT_ID = "studio-bot-01";

const principals = [
  {
    subject: "local-operator",
    tokenSha256: sha256(dashboardToken),
    permissions: ["bot.read", "bot.position.read", "bot.stop", "goal.submit"],
  },
];

const controlLinkClients = [
  {
    clientId: "local-control-api",
    keyId: "control-api-key-01",
    secretSha256: sha256(controlLinkSecret),
    capabilities: ["bot.read", "bot.stop", "goal.submit", "task.read"],
  },
];

const runtimeLinkPeers = [
  {
    keyId: "bot-runtime-key-01",
    botId: BOT_ID,
    secretSha256: sha256(runtimeLinkSecret),
  },
];

const assignments = new Map([
  ["STUDIO_MAX_BOTS", "16"],
  ["CONTROL_API_AUTH_JSON", `'${JSON.stringify(principals)}'`],
  ["COORDINATOR_CONTROL_LINK_CLIENTS_JSON", `'${JSON.stringify(controlLinkClients)}'`],
  ["CONTROL_API_COORDINATOR_LINK_SECRET", controlLinkSecret],
  ["DASHBOARD_CONTROL_API_TOKEN", dashboardToken],
  ["COORDINATOR_RUNTIME_LINK_PEERS_JSON", `'${JSON.stringify(runtimeLinkPeers)}'`],
  ["BOT_RUNTIME_LINK_KEY_ID", "bot-runtime-key-01"],
  ["BOT_RUNTIME_LINK_SECRET", runtimeLinkSecret],
  ["BOT_RUNTIME_LINK_SECRET_STUDIO_BOT_01", runtimeLinkSecret],
  // Normal desktop startup is Manager-first. Isolated Bot Runtime tests provide
  // their profile explicitly and must not be enabled by regenerating .env.
  ["BOT_SERVER_PROFILE_PATH", ""],
  // Durable tasks stay disabled until a real PostgreSQL URL is supplied.
  // loadGoalPersistenceConfig rejects a schema without a URL, so pin both
  // empty here rather than relying on the template's default.
  ["COORDINATOR_TASK_POSTGRES_URL", ""],
  ["COORDINATOR_TASK_POSTGRES_SCHEMA", ""],
]);

let env = readFileSync(".env.example", "utf8");

for (const [key, value] of assignments) {
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (!pattern.test(env)) {
    throw new Error(`key not found in .env.example: ${key}`);
  }
  env = env.replace(pattern, `${key}=${value}`);
}

writeFileSync(".env", env);

console.log(`.env written (${env.split("\n").length} lines)`);
console.log(`dashboard token sha256: ${sha256(dashboardToken)}`);
console.log("plaintext secrets exist only inside .env (gitignored)");
