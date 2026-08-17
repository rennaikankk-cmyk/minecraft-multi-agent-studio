import { HardwareProfiler } from "./profiler.js";

const desiredBots = optionalPositiveInteger(process.env.DESIRED_BOTS);
const profiler = new HardwareProfiler(
  desiredBots === undefined ? {} : { desiredBots },
);
const outputPath = await profiler.write(
  process.env.HARDWARE_PROFILE_PATH || "hardware-profile.json",
);
process.stdout.write(`${outputPath}\n`);

function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^[0-9]+$/u.test(value)) {
    throw new TypeError("DESIRED_BOTS must be a positive integer.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_000) {
    throw new TypeError("DESIRED_BOTS must be between 1 and 1000.");
  }
  return parsed;
}
