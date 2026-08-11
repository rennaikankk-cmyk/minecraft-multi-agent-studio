import { readFile } from "node:fs/promises";

const workflowUrl = new URL(
  "../.github/workflows/minecraft-skill-acceptance.yml",
  import.meta.url,
);
const workflow = await readFile(workflowUrl, "utf8");
const isolatedRunner = await readFile(
  new URL("./run-isolated-minecraft-test.ps1", import.meta.url),
  "utf8",
);

const requiredFragments = [
  "workflow_dispatch:",
  "pull_request:",
  "      - labeled",
  "github.event.action == 'labeled'",
  "github.event.label.name == 'minecraft-acceptance'",
  "github.event.pull_request.head.repo.full_name || github.repository",
  "MINECRAFT_EULA_ACCEPTED",
  "permissions:\n  contents: read",
  "runs-on: windows-2025",
  "server-ip=127.0.0.1",
  "online-mode=false",
  "enable-rcon=false",
  "enable-query=false",
  "persist-credentials: false",
  "https://piston-data.mojang.com/v1/objects/6bce4ef400e4efaa63a13d5e6f6b500be969ef81/server.jar",
  "Get-FileHash -LiteralPath $serverJar -Algorithm SHA1",
  "Get-FileHash -LiteralPath $serverJar -Algorithm SHA256",
  "2349d9a8f0d4be2c40e7692890ef46a4b07015e7955b075460d02793be7fbbe7",
  "pnpm test:minecraft-skills",
];

for (const fragment of requiredFragments) {
  if (!workflow.includes(fragment)) {
    throw new Error(`Minecraft acceptance workflow is missing required guard: ${fragment}`);
  }
}

const forbiddenFragments = [
  "pull_request_target:",
  "permissions: write-all",
  "contents: write",
  "secrets.",
  "purpose: production",
  "networkScope: private-lan",
  "      - synchronize",
  "      - reopened",
];

for (const fragment of forbiddenFragments) {
  if (workflow.includes(fragment)) {
    throw new Error(`Minecraft acceptance workflow contains forbidden capability: ${fragment}`);
  }
}

const requiredRunnerGuards = [
  '"purpose" = "isolated-test"',
  '"networkScope" = "loopback"',
  '"host" = "127.0.0.1"',
  '"port" = 25565',
  '"username" = "StudioBot"',
  '"auth" = "offline"',
  '$serverProfile.minecraftVersion -notin @("auto", "1.21.8")',
  "Get-FileHash -LiteralPath $serverJar -Algorithm SHA256",
  "2349d9a8f0d4be2c40e7692890ef46a4b07015e7955b075460d02793be7fbbe7",
];

for (const guard of requiredRunnerGuards) {
  if (!isolatedRunner.includes(guard)) {
    throw new Error(`Isolated Minecraft runner is missing required guard: ${guard}`);
  }
}

console.log("MINECRAFT_ACCEPTANCE_WORKFLOW_POLICY=PASS");
