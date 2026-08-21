import { z } from "zod";

/** Stable wire identifiers shared by Skill invocations and Bot catalogs. */
export const skillIdentifierSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/u);

export const skillVersionSchema = z
  .string()
  .min(5)
  .max(64)
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
  );
