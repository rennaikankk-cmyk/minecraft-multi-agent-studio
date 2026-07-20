import {
  latestSupportedVersion,
  oldestSupportedVersion,
  testedVersions,
} from "mineflayer";

import type { MinecraftVersionCompatibility } from "@minecraft-studio/protocol";

const VERSION_PATTERN = /^1\.\d+(?:\.\d+)?$/u;
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
): MinecraftVersionCompatibility {
  if (
    !VERSION_PATTERN.test(resolvedVersion) ||
    compareVersions(resolvedVersion, oldestSupportedVersion) < 0 ||
    compareVersions(resolvedVersion, latestSupportedVersion) > 0
  ) {
    throw new Error("Mineflayer resolved a version outside its supported range.");
  }
  return {
    selection: selection === "auto" ? "auto" : "fixed",
    requestedVersion: selection === "auto" ? null : selection,
    resolvedVersion,
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
    /no data for version/iu.test(error.message)
  );
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
