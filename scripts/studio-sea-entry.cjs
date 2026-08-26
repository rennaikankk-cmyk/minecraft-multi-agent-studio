"use strict";

const { createHash } = require("node:crypto");
const {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const path = require("node:path");
const { gunzipSync } = require("node:zlib");
const { pathToFileURL } = require("node:url");
const sea = require("node:sea");

const BUNDLE_ASSET = "studio-bundle.bin.gz";
const BUNDLE_MAGIC = Buffer.from("MMA_STUDIO_BUNDLE_V1\0", "ascii");
const SERVICE_FLAG = "--studio-service";

main().catch((cause) => {
  process.stderr.write(`Minecraft Multi-Agent Studio failed: ${boundedError(cause)}\n`);
  process.exitCode = 1;
});

async function main() {
  const serviceIndex = process.argv.indexOf(SERVICE_FLAG);
  if (serviceIndex >= 0) {
    await runService(serviceIndex);
    return;
  }

  if (process.argv.includes("--version")) {
    process.stdout.write("Minecraft Multi-Agent Studio 0.1.0\n");
    return;
  }

  if (!sea.isSea()) {
    throw new Error("This launcher must be built with pnpm build:exe before it can run.");
  }

  const configRoot = resolveRoot(process.env.STUDIO_CONFIG_ROOT, path.dirname(process.execPath));
  const configValues = {
    ...readSimpleEnvFile(path.join(configRoot, ".env")),
    ...readSimpleEnvFile(path.join(configRoot, ".env.local")),
  };
  const dataRoot = resolveRoot(
    process.env.STUDIO_PORTABLE_ROOT || configValues.STUDIO_PORTABLE_ROOT,
    path.join(path.dirname(process.execPath), "studio-data"),
  );
  const runtimeRoot = resolveRoot(
    process.env.STUDIO_RUNTIME_ROOT || configValues.STUDIO_RUNTIME_ROOT,
    path.join(dataRoot, "runtime-data"),
  );
  const bundleBytes = Buffer.from(sea.getRawAsset(BUNDLE_ASSET));
  const bundleRoot = ensureBundle(dataRoot, bundleBytes);

  process.env.STUDIO_SEA_BUNDLE = "1";
  process.env.STUDIO_BUNDLE_ROOT = bundleRoot;
  process.env.STUDIO_CONFIG_ROOT = configRoot;
  process.env.STUDIO_PORTABLE_ROOT = dataRoot;
  process.env.STUDIO_RUNTIME_ROOT = runtimeRoot;

  await import(pathToFileURL(path.join(bundleRoot, "scripts", "start-studio.mjs")).href);
}

async function runService(serviceIndex) {
  if (!sea.isSea()) {
    throw new Error("Service mode is only available inside the Studio executable.");
  }
  const relativeEntry = process.argv[serviceIndex + 1];
  if (!relativeEntry || relativeEntry.startsWith("-") || path.isAbsolute(relativeEntry)) {
    throw new Error("The packaged service entry is invalid.");
  }

  const bundleRoot = resolveRoot(process.env.STUDIO_BUNDLE_ROOT, "");
  if (!bundleRoot) throw new Error("STUDIO_BUNDLE_ROOT is missing for a packaged service.");
  const entry = resolveContainedPath(bundleRoot, relativeEntry);
  if (!existsSync(entry) || !statSync(entry).isFile()) {
    throw new Error(`Packaged service entry is missing: ${relativeEntry}`);
  }

  process.env.STUDIO_SEA_BUNDLE = "1";
  process.env.STUDIO_BUNDLE_ROOT = bundleRoot;
  process.on("message", (message) => {
    if (message?.type === "studio.shutdown") process.emit("SIGTERM");
  });
  process.argv = [process.argv[0], entry, ...process.argv.slice(serviceIndex + 2)];
  await import(pathToFileURL(entry).href);
}

function ensureBundle(dataRoot, compressed) {
  const fingerprint = createHash("sha256").update(compressed).digest("hex");
  const cacheRoot = path.join(dataRoot, "bundle-cache", fingerprint.slice(0, 24));
  const completeMarker = path.join(cacheRoot, ".complete");
  if (isCompleteBundle(cacheRoot, completeMarker, fingerprint)) return cacheRoot;
  if (existsSync(cacheRoot)) {
    rmSync(cacheRoot, { recursive: true, force: true });
  }

  const cacheParent = path.dirname(cacheRoot);
  mkdirSync(cacheParent, { recursive: true });
  const temporaryRoot = path.join(
    cacheParent,
    `.extract-${process.pid}-${Date.now().toString(36)}`,
  );
  mkdirSync(temporaryRoot, { recursive: true });
  try {
    extractArchive(temporaryRoot, gunzipSync(compressed));
    writeFileSync(completeMarkerPath(temporaryRoot), `${fingerprint}\n`, "utf8");
    try {
      renameSync(temporaryRoot, cacheRoot);
    } catch (cause) {
      if (!existsSync(completeMarker)) throw cause;
    }
    return cacheRoot;
  } finally {
    if (existsSync(temporaryRoot)) rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function isCompleteBundle(cacheRoot, completeMarker, fingerprint) {
  if (!existsSync(completeMarker)) return false;
  try {
    if (readFileSync(completeMarker, "utf8").trim() !== fingerprint) return false;
    for (const required of [
      "scripts/start-studio.mjs",
      "apps/coordinator/dist/main.js",
      "apps/control-api/dist/main.js",
      "apps/dashboard/.next/standalone/apps/dashboard/server.js",
    ]) {
      const candidate = resolveContainedPath(cacheRoot, required);
      if (!existsSync(candidate) || !statSync(candidate).isFile()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function completeMarkerPath(root) {
  return path.join(root, ".complete");
}

function extractArchive(root, archive) {
  let offset = 0;
  if (!archive.subarray(0, BUNDLE_MAGIC.length).equals(BUNDLE_MAGIC)) {
    throw new Error("The embedded Studio bundle has an invalid header.");
  }
  offset += BUNDLE_MAGIC.length;
  const fileCount = readUInt32(archive, offset);
  offset += 4;
  if (fileCount < 1 || fileCount > 100_000) {
    throw new Error("The embedded Studio bundle has an invalid file count.");
  }

  for (let index = 0; index < fileCount; index += 1) {
    const nameLength = readUInt32(archive, offset);
    offset += 4;
    const contentLength = readUInt64(archive, offset);
    offset += 8;
    if (nameLength < 1 || nameLength > 4096 || contentLength > archive.length - offset - nameLength) {
      throw new Error("The embedded Studio bundle has an invalid entry.");
    }
    const name = archive.subarray(offset, offset + nameLength).toString("utf8");
    offset += nameLength;
    const destination = resolveContainedPath(root, name);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, archive.subarray(offset, offset + contentLength));
    offset += contentLength;
  }
  if (offset !== archive.length) throw new Error("The embedded Studio bundle has trailing data.");
}

function resolveContainedPath(root, relativeName) {
  const normalizedName = String(relativeName).replaceAll("\\", "/");
  if (!normalizedName || normalizedName.startsWith("/") || normalizedName.includes("\0")) {
    throw new Error("The embedded Studio bundle contains an unsafe path.");
  }
  const rootPath = path.resolve(root);
  const destination = path.resolve(rootPath, ...normalizedName.split("/"));
  if (destination !== rootPath && !destination.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error("The embedded Studio bundle contains a path traversal entry.");
  }
  return destination;
}

function readUInt32(buffer, offset) {
  if (offset < 0 || offset + 4 > buffer.length) throw new Error("The embedded Studio bundle is truncated.");
  return buffer.readUInt32LE(offset);
}

function readUInt64(buffer, offset) {
  if (offset < 0 || offset + 8 > buffer.length) throw new Error("The embedded Studio bundle is truncated.");
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("The embedded Studio bundle is too large.");
  return Number(value);
}

function readSimpleEnvFile(filePath) {
  try {
    const values = {};
    for (const line of readFileSync(filePath, "utf8").split(/\r?\n/u)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u);
      if (!match) continue;
      let value = match[2];
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      values[match[1]] = value;
    }
    return values;
  } catch (cause) {
    if (cause?.code === "ENOENT") return {};
    throw new Error(`Unable to read ${path.basename(filePath)}: ${boundedError(cause)}`);
  }
}

function resolveRoot(value, fallback) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return path.resolve(trimmed || fallback);
}

function boundedError(cause) {
  return (cause instanceof Error ? cause.message : String(cause))
    .replace(/[\r\n\t]+/gu, " ")
    .slice(0, 500);
}
