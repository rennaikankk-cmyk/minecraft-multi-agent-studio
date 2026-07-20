const baseUrl = process.env.STUDIO_SMOKE_BASE_URL ?? "http://127.0.0.1:3000";
const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

let apiResponse;
for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    apiResponse = await fetch(`${baseUrl}/api/environment`, { cache: "no-store" });
    if (apiResponse.ok) break;
  } catch {
    // The production server may still be starting.
  }
  await wait(500);
}

if (!apiResponse?.ok) {
  throw new Error("Environment API did not become available in time.");
}

const body = await apiResponse.json();
const environment = body.environment;

if (environment?.schemaVersion !== "1.0") {
  throw new Error("Environment API returned an invalid schema version.");
}
if (environment.hardware?.cpu?.logicalCores < 1) {
  throw new Error("Environment API returned an invalid CPU result.");
}
if (environment.software?.length !== 4) {
  throw new Error("Environment API returned an invalid software probe list.");
}

const homeResponse = await fetch(`${baseUrl}/`);
const html = await homeResponse.text();
if (!homeResponse.ok || !html.includes("Minecraft Multi-Agent Studio")) {
  throw new Error("Dashboard home page is unavailable.");
}

console.log(
  JSON.stringify(
    {
      api: "passed",
      homePage: "passed",
      mode: environment.mode.value,
      platform: environment.hardware.platform,
      cpu: environment.hardware.cpu.model,
      logicalCores: environment.hardware.cpu.logicalCores,
      totalMemoryGiB: Number(
        (environment.hardware.memory.totalBytes / 1024 ** 3).toFixed(2),
      ),
      gpuProbe: environment.hardware.gpu.status,
      softwareProbes: environment.software.length,
    },
    null,
    2,
  ),
);
