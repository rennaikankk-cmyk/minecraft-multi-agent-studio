import type {
  SkillCompatibilityEnvironment,
  SkillCompatibilityRequirement,
  SkillCompatibilityResolution,
  SkillCompatibilityUnmetRequirement,
  SkillDefinition,
  SkillVariantCompatibility,
} from "./types.js";

type AnySkillDefinition = SkillDefinition<unknown, unknown, unknown>;

function evaluateBoolean(
  value: boolean | undefined,
  requirement: SkillCompatibilityRequirement,
): SkillCompatibilityUnmetRequirement | null {
  if (value === true) return null;
  return Object.freeze({
    requirement,
    status: value === false ? "missing" : "unknown",
  });
}

function evaluateResource(
  requirement: Extract<SkillCompatibilityRequirement, { kind: "resource" }>,
  environment: SkillCompatibilityEnvironment,
): SkillCompatibilityUnmetRequirement | null {
  const results = requirement.names.map((name) =>
    environment.hasResource(requirement.resource, name),
  );
  if (requirement.match === "any") {
    if (results.includes(true)) return null;
    return Object.freeze({
      requirement,
      status: results.includes(undefined) ? "unknown" : "missing",
    });
  }
  if (results.includes(false)) {
    return Object.freeze({ requirement, status: "missing" });
  }
  if (results.includes(undefined)) {
    return Object.freeze({ requirement, status: "unknown" });
  }
  return null;
}

function evaluateRequirement(
  requirement: SkillCompatibilityRequirement,
  environment: SkillCompatibilityEnvironment | null,
): SkillCompatibilityUnmetRequirement | null {
  if (!environment) {
    return Object.freeze({ requirement, status: "unknown" });
  }
  if (requirement.kind === "feature") {
    return evaluateBoolean(
      environment.supportsFeature(requirement.name),
      requirement,
    );
  }
  if (requirement.kind === "resource") {
    return evaluateResource(requirement, environment);
  }
  return evaluateBoolean(
    environment.serverCapability(requirement.name),
    requirement,
  );
}

/**
 * Resolves one registered skill against facts from the negotiated Minecraft
 * protocol and the current server. Version labels are deliberately not used
 * as a min/max gate: concrete resources, adapter features, and probed server
 * capabilities decide whether an implementation variant can run.
 */
export function resolveSkillCompatibility(
  definition: AnySkillDefinition,
  environment: SkillCompatibilityEnvironment | null,
): SkillCompatibilityResolution {
  const variants: SkillVariantCompatibility[] = definition.compatibility.variants.map(
    (variant) => {
      const unmetRequirements = variant.requirements
        .map((requirement) => evaluateRequirement(requirement, environment))
        .filter(
          (result): result is SkillCompatibilityUnmetRequirement =>
            result !== null,
        );
      return Object.freeze({
        variantId: variant.id,
        available: unmetRequirements.length === 0,
        verification:
          environment &&
          variant.verifiedMinecraftVersions.includes(
            environment.minecraftVersion,
          )
            ? "verified"
            : "unverified",
        unmetRequirements: Object.freeze(unmetRequirements),
      });
    },
  );
  const selected = variants.find(({ available }) => available) ?? null;
  return Object.freeze({
    skillId: definition.id,
    skillVersion: definition.version,
    minecraftVersion: environment?.minecraftVersion ?? null,
    protocolVersion: environment?.protocolVersion ?? null,
    availability: selected ? "available" : "unavailable",
    verification: selected?.verification ?? "unverified",
    selectedVariantId: selected?.variantId ?? null,
    variants: Object.freeze(variants),
  });
}
