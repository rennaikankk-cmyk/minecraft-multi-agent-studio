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
const isolatedPreparation = await readFile(
  new URL("./prepare-isolated-minecraft.ps1", import.meta.url),
  "utf8",
);
const realIntegrationTest = await readFile(
  new URL(
    "../apps/bot-runtime/tests/real-isolated-server.integration.test.ts",
    import.meta.url,
  ),
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
  "run: pnpm build",
  "pnpm test:minecraft-skills",
];

for (const fragment of requiredFragments) {
  if (!workflow.includes(fragment)) {
    throw new Error(`Minecraft acceptance workflow is missing required guard: ${fragment}`);
  }
}

const buildCommandIndex = workflow.indexOf("run: pnpm build");
const acceptanceCommandIndex = workflow.indexOf("run: pnpm test:minecraft-skills");
if (buildCommandIndex < 0 || acceptanceCommandIndex < 0) {
  throw new Error("Minecraft acceptance workflow is missing an exact build or test command.");
}
if (buildCommandIndex >= acceptanceCommandIndex) {
  throw new Error("Minecraft acceptance workflow must build before running real skill tests.");
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
  'Assert-ContainedPath -Candidate $ServerDirectory -Root $runtimeRoot',
  'Assert-NoReparsePointInPath -Path $ServerDirectory -Label "Server directory"',
  'Assert-NoReparsePointInPath -Path $acceptanceRoot -Label "Acceptance directory"',
  '"fill -8 60 -6 10 70 6 minecraft:air replace"',
  '"kill @e[type=minecraft:item,x=-8,y=60,z=-6,dx=18,dy=10,dz=12]"',
  '"setblock 5 65 0 minecraft:oak_log replace"',
  '"setblock 5 65 -2 minecraft:chest replace"',
  '"setblock 3 65 -2 minecraft:furnace replace"',
  '"MMS_FIXTURE_READY_V1"',
  ".AddMinutes(8)",
  "ReadToEndAsync()",
];

for (const guard of requiredRunnerGuards) {
  if (!isolatedRunner.includes(guard)) {
    throw new Error(`Isolated Minecraft runner is missing required guard: ${guard}`);
  }
}

const requiredRealSkillCoverage = [
  'execute("movement.goto"',
  'execute("collect.block"',
  'execute("craft.item"',
  'execute("world.place-block"',
  'execute("container.transfer"',
  'execute("inventory.equip-armor"',
  'execute("smelt.item"',
  'maxDistance: 4',
  'expect(outputNumber(collectOutput, "itemsCollected")).toBe(1);',
  "expect(completedSkillIds).toEqual(REAL_ACCEPTANCE_SKILL_IDS)",
];

for (const fragment of requiredRealSkillCoverage) {
  if (!realIntegrationTest.includes(fragment)) {
    throw new Error(`Real Minecraft acceptance is missing skill coverage: ${fragment}`);
  }
}

const requiredPreparationGuards = [
  '"https://piston-data.mojang.com/v1/objects/6bce4ef400e4efaa63a13d5e6f6b500be969ef81/server.jar"',
  '$script:ExpectedSha1 = "6bce4ef400e4efaa63a13d5e6f6b500be969ef81"',
  '$script:ExpectedSha256 = "2349d9a8f0d4be2c40e7692890ef46a4b07015e7955b075460d02793be7fbbe7"',
  'Join-Path $projectRoot "runtime-data\\isolated-test"',
  '"server-ip=127.0.0.1"',
  '"online-mode=false"',
  '"enable-rcon=false"',
  '"enable-query=false"',
  '"eula=false$([Environment]::NewLine)"',
  'minecraftVersion = $script:MinecraftVersion',
  'purpose = "isolated-test"',
  'networkScope = "loopback"',
  'Assert-ServerJarHash -Path $temporaryJar',
];

for (const guard of requiredPreparationGuards) {
  if (!isolatedPreparation.includes(guard)) {
    throw new Error(`Isolated Minecraft preparation script is missing required guard: ${guard}`);
  }
}

const forbiddenPreparationFragments = [
  "AcceptEula",
  "param([switch]$AcceptEula)",
  "param( [switch]$AcceptEula )",
  "eula=true$([Environment]::NewLine)",
  "eula=true`n",
  "eula=true\n",
  "Start-Process",
];

for (const fragment of forbiddenPreparationFragments) {
  if (isolatedPreparation.includes(fragment)) {
    throw new Error(`Isolated Minecraft preparation script contains forbidden behavior: ${fragment}`);
  }
}

console.log("MINECRAFT_ACCEPTANCE_WORKFLOW_POLICY=PASS");
