#!/usr/bin/env node

import { accessSync, constants, lstatSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isIP } from "node:net";

function usage() {
  console.error("Usage: node scripts/validate-spark-ornith-deployment.mjs --env-file /absolute/profile.env");
}

function parseEnvFile(filePath) {
  const values = Object.create(null);
  const source = readFileSync(filePath, "utf8");
  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match) throw new Error(`invalid assignment at ${filePath}:${index + 1}`);
    let value = match[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
      if (match[2].trim().startsWith('"')) {
        value = value.replace(/\\([\\"nrt])/gu, (_all, escaped) => ({ "\\": "\\", '"': '"', n: "\n", r: "\r", t: "\t" })[escaped]);
      }
    }
    values[match[1]] = value;
  }
  return values;
}

function requireText(values, name, errors) {
  const value = values[name];
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${name} is required`);
    return "";
  }
  return value.trim();
}

function requireNumber(values, name, expected, errors) {
  const text = requireText(values, name, errors);
  const value = Number(text);
  if (!Number.isFinite(value) || value !== expected) errors.push(`${name} must be ${expected}`);
  return value;
}

function parseJson(values, name, errors) {
  const text = requireText(values, name, errors);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    errors.push(`${name} must be valid JSON`);
    return null;
  }
}

function checkDirectory(rawPath, name, errors) {
  if (!rawPath) return;
  if (!isAbsolute(rawPath)) {
    errors.push(`${name} must be an absolute path`);
    return;
  }
  try {
    if (!statSync(rawPath).isDirectory()) errors.push(`${name} is not a directory`);
  } catch {
    errors.push(`${name} does not exist`);
  }
}

function main() {
  const envFlag = process.argv.indexOf("--env-file");
  const envPath = envFlag >= 0 ? process.argv[envFlag + 1] : "";
  if (!envPath || envPath.startsWith("--")) {
    usage();
    return 2;
  }

  const errors = [];
  let values;
  try {
    values = parseEnvFile(resolve(envPath));
  } catch (error) {
    console.error(`cannot read profile env file: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const profile = requireText(values, "SPARK_DEPLOYMENT_PROFILE", errors);
  if (!["canary", "production"].includes(profile)) {
    errors.push("SPARK_DEPLOYMENT_PROFILE must be canary or production");
  }

  const image = requireText(values, "SPARK_VLLM_IMAGE", errors);
  if (image && !/(?:@sha256:|^sha256:)[0-9a-f]{64}$/iu.test(image)) {
    errors.push("SPARK_VLLM_IMAGE must be a repo digest or immutable sha256 image ID");
  }

  const revision = requireText(values, "SPARK_MODEL_REVISION", errors);
  if (revision && !/^[0-9a-f]{40}$/iu.test(revision)) {
    errors.push("SPARK_MODEL_REVISION must be a 40-character Git commit SHA");
  }

  const modelPath = requireText(values, "SPARK_MODEL_PATH", errors);
  const cachePath = requireText(values, "SPARK_CACHE_PATH", errors);
  checkDirectory(modelPath, "SPARK_MODEL_PATH", errors);
  checkDirectory(cachePath, "SPARK_CACHE_PATH", errors);
  if (cachePath && isAbsolute(cachePath)) {
    try {
      accessSync(cachePath, constants.W_OK);
    } catch {
      errors.push("SPARK_CACHE_PATH is not writable");
    }
  }

  const keyPath = requireText(values, "SPARK_API_KEY_ENV_FILE", errors);
  if (keyPath) {
    if (!isAbsolute(keyPath)) errors.push("SPARK_API_KEY_ENV_FILE must be an absolute path");
    try {
      const keyStat = lstatSync(keyPath);
      if (!keyStat.isFile() || keyStat.isSymbolicLink()) errors.push("SPARK_API_KEY_ENV_FILE must be a regular file");
      if ((keyStat.mode & 0o777) !== 0o600) errors.push("SPARK_API_KEY_ENV_FILE must have mode 600");
      const keyValues = parseEnvFile(keyPath);
      const keyNames = Object.keys(keyValues);
      if (keyNames.length !== 1 || keyNames[0] !== "VLLM_API_KEY") errors.push("SPARK_API_KEY_ENV_FILE must contain only VLLM_API_KEY");
      const apiKey = keyValues.VLLM_API_KEY?.trim() ?? "";
      if (!apiKey) errors.push("VLLM_API_KEY is empty in the API-key file");
      else if (apiKey.length < 32 || apiKey.length > 4_096) errors.push("VLLM_API_KEY must contain 32 to 4096 characters");
    } catch (error) {
      errors.push(`SPARK_API_KEY_ENV_FILE cannot be read (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  const bindAddress = requireText(values, "SPARK_BIND_ADDRESS", errors);
  if (bindAddress && (!isIP(bindAddress) || ["0.0.0.0", "::"].includes(bindAddress))) {
    errors.push("SPARK_BIND_ADDRESS must be a concrete trusted IPv4/IPv6 address, not a wildcard");
  }

  const expectedPort = profile === "production" ? 8000 : 8001;
  const expectedGpu = profile === "production" ? 0.9 : 0.85;
  const expectedBatchTokens = profile === "production" ? 65536 : 32768;
  const expectedRestartPolicy = profile === "production" ? "unless-stopped" : "no";
  const restartPolicy = requireText(values, "SPARK_RESTART_POLICY", errors);
  if (restartPolicy && restartPolicy !== expectedRestartPolicy) {
    errors.push(`SPARK_RESTART_POLICY must be ${expectedRestartPolicy} for ${profile}`);
  }
  requireNumber(values, "SPARK_HOST_PORT", expectedPort, errors);
  requireNumber(values, "SPARK_GPU_MEMORY_UTILIZATION", expectedGpu, errors);
  requireNumber(values, "SPARK_MAX_NUM_BATCHED_TOKENS", expectedBatchTokens, errors);
  requireNumber(values, "SPARK_MAX_MODEL_LEN", 262144, errors);
  requireNumber(values, "SPARK_MAX_NUM_SEQS", 16, errors);

  const kvDtype = requireText(values, "SPARK_KV_CACHE_DTYPE", errors);
  if (kvDtype && !["fp8", "fp8_e4m3"].includes(kvDtype.toLowerCase())) errors.push("SPARK_KV_CACHE_DTYPE must be fp8 or fp8_e4m3");
  const loadStrategy = requireText(values, "SPARK_SAFETENSORS_LOAD_STRATEGY", errors);
  if (loadStrategy && loadStrategy.toLowerCase() !== "prefetch") errors.push("SPARK_SAFETENSORS_LOAD_STRATEGY must be prefetch");
  const reasoningParser = requireText(values, "SPARK_REASONING_PARSER", errors);
  if (reasoningParser && reasoningParser !== "qwen3") errors.push("SPARK_REASONING_PARSER must be qwen3");
  const toolParser = requireText(values, "SPARK_TOOL_CALL_PARSER", errors);
  if (toolParser && toolParser !== "qwen3_xml") errors.push("SPARK_TOOL_CALL_PARSER must be qwen3_xml");
  const mtpExpected = requireText(values, "SPARK_MTP_EXPECTED", errors).toLowerCase();
  if (!["true", "false"].includes(mtpExpected)) {
    errors.push("SPARK_MTP_EXPECTED must be true or false");
  }
  const speculativeText = values.SPARK_SPECULATIVE_CONFIG?.trim() ?? "";
  if (mtpExpected === "false" && speculativeText) {
    errors.push("SPARK_SPECULATIVE_CONFIG must be empty when MTP is not expected");
  }
  if (mtpExpected === "true") {
    const speculative = parseJson(values, "SPARK_SPECULATIVE_CONFIG", errors);
    if (speculative && (speculative.method !== "mtp" || speculative.num_speculative_tokens !== 2)) {
      errors.push("SPARK_SPECULATIVE_CONFIG must select MTP with two speculative tokens");
    }
  }
  const multimodal = parseJson(values, "SPARK_LIMIT_MM_PER_PROMPT", errors);
  if (multimodal && (multimodal.image !== 1 || multimodal.video !== 0)) {
    errors.push('SPARK_LIMIT_MM_PER_PROMPT must be {"image":1,"video":0}');
  }

  if (errors.length > 0) {
    console.error("Spark Ornith deployment preflight: FAIL");
    for (const error of errors) console.error(`- ${error}`);
    return 1;
  }

  console.log("Spark Ornith deployment preflight: PASS");
  console.log(`profile=${profile} hostPort=${values.SPARK_HOST_PORT} modelRevision=${revision}`);
  console.log(`imageDigestPinned=true modelPath=${modelPath} apiKeyFileMode=600`);
  return 0;
}

process.exitCode = main();
