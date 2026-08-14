import mineflayer from "mineflayer";

import type { MinecraftVersionCompatibility } from "@minecraft-studio/protocol";

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u;
const {
  latestSupportedVersion,
  oldestSupportedVersion,
  testedVersions,
} = mineflayer;
const installedTestedVersions = Object.freeze([...testedVersions]);
const installedTestedVersionSet = new Set(installedTestedVersions);

if (
  installedTestedVersions.length === 0 ||
  !VERSION_PATTERN.test(oldestSupportedVersion) ||
  !VERSION_PATTERN.test(latestSupportedVersion) ||
  installedTestedVersions[0] !== oldestSupportedVersion ||
  installedTestedVersions.at(-1) !== latestSupportedVersion
) {
  throw new Error("Mineflayer reported an invalid supported version range.");
}

export type MinecraftVersionSelection = "auto" | string;

export const mineflayerVersionSupport = Object.freeze({
  oldest: oldestSupportedVersion,
  latest: latestSupportedVersion,
  testedVersions: installedTestedVersions,
});

export function isMineflayerTestedVersion(version: string): boolean {
  return installedTestedVersionSet.has(version);
}

export function mineflayerVersionOption(
  selection: MinecraftVersionSelection,
): string | false {
  return selection === "auto" ? false : selection;
}

export function resolvedVersionCompatibility(
  selection: MinecraftVersionSelection,
  resolvedVersion: string,
  protocolVersion: number,
  majorVersion: string,
): MinecraftVersionCompatibility {
  if (
    !VERSION_PATTERN.test(resolvedVersion) ||
    !VERSION_PATTERN.test(majorVersion) ||
    !Number.isSafeInteger(protocolVersion) ||
    protocolVersion < 0
  ) {
    throw new Error("Mineflayer resolved invalid version metadata.");
  }
  return {
    selection: selection === "auto" ? "auto" : "fixed",
    requestedVersion: selection === "auto" ? null : selection,
    resolvedVersion,
    protocolVersion,
    majorVersion,
    supportLevel: isMineflayerTestedVersion(resolvedVersion)
      ? "tested"
      : "compatible-untested",
    supportedRange: {
      oldest: oldestSupportedVersion,
      latest: latestSupportedVersion,
    },
  };
}

export function unsupportedVersionCompatibility(
  selection: MinecraftVersionSelection,
): MinecraftVersionCompatibility {
  return {
    selection: selection === "auto" ? "auto" : "fixed",
    requestedVersion: selection === "auto" ? null : selection,
    resolvedVersion: null,
    protocolVersion: null,
    majorVersion: null,
    supportLevel: "unsupported",
    supportedRange: {
      oldest: oldestSupportedVersion,
      latest: latestSupportedVersion,
    },
  };
}

export function isMineflayerUnsupportedVersionError(error: Error): boolean {
  return (
    /Server version .* is not supported/iu.test(error.message) ||
    /no data for version/iu.test(error.message) ||
    /unsupported(?:\/unknown)? protocol version/iu.test(error.message)
  );
}
