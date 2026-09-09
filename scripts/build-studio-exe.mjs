import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";

import { build as buildWithEsbuild } from "esbuild";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const buildRoot = path.join(repositoryRoot, ".studio-exe");
const stagingRoot = path.join(buildRoot, "staging");
const archivePath = path.join(buildRoot, "studio-bundle.bin.gz");
const seaConfigPath = path.join(buildRoot, "sea-config.json");
const seaBlobPath = path.join(buildRoot, "sea-prep.blob");
const outputPath = path.resolve(
  process.env.STUDIO_EXE_OUTPUT?.trim() ||
    path.join(repositoryRoot, "dist", "MinecraftMultiAgentStudio.exe"),
);
const bundleMagic = Buffer.from("MMA_STUDIO_BUNDLE_V1\0", "ascii");
const postjectSentinel = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

if (process.platform !== "win32") {
  throw new Error("The Studio EXE builder currently targets Windows only.");
}
if (process.arch !== "x64" && process.arch !== "arm64") {
  throw new Error(`Unsupported Windows architecture: ${process.arch}.`);
}

const skipBuild = process.argv.includes("--skip-build");
if (!skipBuild) {
  await run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "pnpm build"], repositoryRoot);
}

await rm(buildRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
await mkdir(stagingRoot, { recursive: true });
await mkdir(path.dirname(outputPath), { recursive: true });

await bundleBackend("apps/coordinator/dist/main.js", "apps/coordinator/dist/main.js");
await bundleBackend("apps/control-api/dist/main.js", "apps/control-api/dist/main.js");
await bundleBackend("apps/task-worker/dist/main.js", "apps/task-worker/dist/main.js");
await buildBotRuntimeBundles();
await mkdir(path.join(stagingRoot, "scripts"), { recursive: true });
await copyFile(
  path.join(repositoryRoot, "scripts", "start-studio.mjs"),
  path.join(stagingRoot, "scripts", "start-studio.mjs"),
);
await copyFile(
  path.join(repositoryRoot, "scripts", "studio-local-manager.mjs"),
  path.join(stagingRoot, "scripts", "studio-local-manager.mjs"),
);
await bundleManagedIdentity();
await writeFile(
  path.join(stagingRoot, "package.json"),
  '{"name":"minecraft-multi-agent-studio-bundle","private":true,"type":"commonjs"}\n',
  "utf8",
);
await copyDashboardRuntime();
await copyCompactMinecraftData();

const archive = await createArchive(stagingRoot);
await writeFile(archivePath, gzipSync(archive, { level: 9 }));
const archiveDigest = createHash("sha256").update(archive).digest("hex");
const compressedSize = (await stat(archivePath)).size;

await writeFile(
  seaConfigPath,
  `${JSON.stringify(
    {
      main: path.join(repositoryRoot, "scripts", "studio-sea-entry.cjs"),
      output: seaBlobPath,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      assets: { "studio-bundle.bin.gz": archivePath },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
await run(process.execPath, ["--experimental-sea-config", seaConfigPath], repositoryRoot);
await rm(outputPath, { force: true });
await copyFile(process.execPath, outputPath);
await run(
  process.execPath,
  [
    path.join(repositoryRoot, "node_modules", "postject", "dist", "cli.js"),
    outputPath,
    "NODE_SEA_BLOB",
    seaBlobPath,
    "--sentinel-fuse",
    postjectSentinel,
  ],
  repositoryRoot,
);

const outputSize = (await stat(outputPath)).size;
process.stdout.write(
  [
    `Studio EXE created: ${outputPath}`,
    `Embedded bundle: ${(compressedSize / 1024 / 1024).toFixed(1)} MiB compressed`,
    `Archive digest: ${archiveDigest}`,
    `Executable size: ${(outputSize / 1024 / 1024).toFixed(1)} MiB`,
  ].join("\n") + "\n",
);

async function bundleBackend(sourceRelative, destinationRelative) {
  const outfile = path.join(stagingRoot, destinationRelative);
  await mkdir(path.dirname(outfile), { recursive: true });
  await buildWithEsbuild({
    entryPoints: [path.join(repositoryRoot, sourceRelative)],
    outfile,
    absWorkingDir: repositoryRoot,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    sourcemap: false,
    minify: false,
    logLevel: "warning",
  });
}

async function bundleManagedIdentity() {
  const target = path.join(stagingRoot, "scripts", "lib");
  await mkdir(target, { recursive: true });
  // Keep the resolver as ESM because its bounded authentication worker loads the
  // same module by import.meta.url. Authflow itself is a fixed standalone CJS
  // bundle so extracted executables require no development node_modules.
  await copyFile(path.join(repositoryRoot, "scripts", "lib", "managed-game-identity.mjs"), path.join(target, "managed-game-identity.mjs"));
  const runtimeRequire = createRequire(path.join(repositoryRoot, "apps", "bot-runtime", "package.json"));
  await buildWithEsbuild({
    entryPoints: [runtimeRequire.resolve("prismarine-auth")],
    outfile: path.join(target, "prismarine-auth.cjs"),
    absWorkingDir: repositoryRoot,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    sourcemap: false,
    minify: false,
    logLevel: "warning",
  });
}

async function buildBotRuntimeBundles() {
  const outdir = path.join(stagingRoot, "apps", "bot-runtime", "dist");
  await mkdir(outdir, { recursive: true });
  await buildWithEsbuild({
    entryPoints: {
      index: path.join(repositoryRoot, "apps", "bot-runtime", "dist", "index.js"),
      "supervisor-main": path.join(
        repositoryRoot,
        "apps",
        "bot-runtime",
        "dist",
        "supervisor-main.js",
      ),
      "supervisor-child": path.join(
        repositoryRoot,
        "apps",
        "bot-runtime",
        "dist",
        "supervisor-child.js",
      ),
    },
    outdir,
    absWorkingDir: repositoryRoot,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["minecraft-data"],
    sourcemap: false,
    minify: false,
    logLevel: "warning",
  });
}

async function copyDashboardRuntime() {
  const standaloneSource = path.join(repositoryRoot, "apps", "dashboard", ".next", "standalone");
  const standaloneTarget = path.join(stagingRoot, "apps", "dashboard", ".next", "standalone");
  await copyTree(standaloneSource, standaloneTarget);
  const staticSource = path.join(repositoryRoot, "apps", "dashboard", ".next", "static");
  const staticTarget = path.join(
    standaloneTarget,
    "apps",
    "dashboard",
    ".next",
    "static",
  );
  await copyTree(staticSource, staticTarget);

  // Next's standalone trace preserves pnpm's virtual store layout. Once the
  // junctions are dereferenced into an archive, Node no longer walks the
  // original .pnpm parent when resolving dependencies from the copied `next`
  // package. Flatten the traced dependency aliases beside it so the extracted
  // server has ordinary portable Node resolution semantics.
  const tracedModules = path.join(standaloneTarget, "node_modules", ".pnpm", "node_modules");
  const dashboardModules = path.join(
    standaloneTarget,
    "apps",
    "dashboard",
    "node_modules",
  );
  try {
    const entries = await readdir(tracedModules, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".bin" || entry.name === "next") continue;
      await copyTree(
        path.join(tracedModules, entry.name),
        path.join(dashboardModules, entry.name),
      );
    }
  } catch (cause) {
    if (cause?.code !== "ENOENT") throw cause;
  }
}

async function copyCompactMinecraftData() {
  const mineflayerSource = await realpath(
    path.join(repositoryRoot, "apps", "bot-runtime", "node_modules", "mineflayer"),
  );
  const source = await realpath(
    path.join(path.dirname(mineflayerSource), "minecraft-data"),
  );
  const target = path.join(stagingRoot, "node_modules", "minecraft-data");
  await copyTree(source, target, {
    filter(relativeName) {
      const normalized = relativeName.split(path.sep).join("/");
      const topLevel = normalized.split("/")[0];
      if ([".github", "bin", "doc", "test", "typings"].includes(topLevel)) return false;
      if (topLevel.startsWith(".git")) return false;
      if (
        normalized === "minecraft-data/data/bedrock" ||
        normalized === "minecraft-data/data/bedrock/common"
      ) {
        return true;
      }
      if (
        normalized.startsWith("minecraft-data/data/bedrock/") &&
        !normalized.startsWith("minecraft-data/data/bedrock/common/")
      ) {
        return false;
      }
      return true;
    },
  });
}

async function copyTree(source, destination, options = {}, active = new Set()) {
  const physicalPath = await realpath(source);
  const effectiveOptions = options.relativeRoot
    ? options
    : { ...options, relativeRoot: physicalPath };
  const relativeName = path.relative(effectiveOptions.relativeRoot, physicalPath);
  if (effectiveOptions.filter && !effectiveOptions.filter(relativeName)) return;
  if (active.has(physicalPath)) return;
  const physicalStat = await stat(physicalPath);
  if (physicalStat.isDirectory()) {
    await mkdir(destination, { recursive: true });
    const nextActive = new Set(active);
    nextActive.add(physicalPath);
    const entries = await readdir(physicalPath, { withFileTypes: true });
    for (const entry of entries) {
      const childSource = path.join(source, entry.name);
      const childDestination = path.join(destination, entry.name);
      await copyTree(childSource, childDestination, effectiveOptions, nextActive);
    }
    return;
  }
  if (!physicalStat.isFile()) return;
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(physicalPath, destination);
}

async function createArchive(root) {
  const files = [];
  await collectFiles(root, root, files);
  files.sort((left, right) => left.name.localeCompare(right.name));
  const chunks = [bundleMagic, uint32(files.length)];
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const content = await readFile(file.path);
    chunks.push(uint32(name.length), uint64(content.length), name, content);
  }
  return Buffer.concat(chunks);
}

async function collectFiles(root, current, files) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(current, entry.name);
    const physical = await realpath(source);
    const physicalStat = await stat(physical);
    if (physicalStat.isDirectory()) {
      await collectFiles(root, source, files);
    } else if (physicalStat.isFile()) {
      files.push({
        path: physical,
        name: path.relative(root, source).split(path.sep).join("/"),
      });
    }
  }
}

function uint32(value) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

function uint64(value) {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64LE(BigInt(value), 0);
  return buffer;
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} failed (code=${code ?? "none"}, signal=${signal ?? "none"}).`));
    });
  });
}
