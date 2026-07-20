import { createStructuredLogger } from "@minecraft-studio/observability";

export const dashboardLogger = createStructuredLogger({
  service: "dashboard",
  instanceId: `dashboard-${process.pid}`,
});
