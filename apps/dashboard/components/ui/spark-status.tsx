// Spark 状态徽章 —— READY/DEGRADED/UNAVAILABLE/MISCONFIGURED 词汇唯一来源
// （状态不只靠颜色：icon + label 并用）。
import { CheckCircle2, AlertTriangle, XCircle, Ban, HelpCircle } from "lucide-react";

import { Badge } from "@/components/ui/primitives";

export function SparkStatusBadge({ state }: { state: string }) {
  switch (state) {
    case "connected":
      return (
        <Badge tone="ai">
          <CheckCircle2 className="size-3" aria-hidden /> READY
        </Badge>
      );
    case "degraded":
      return (
        <Badge tone="degraded">
          <AlertTriangle className="size-3" aria-hidden /> DEGRADED
        </Badge>
      );
    case "misconfigured":
      return (
        <Badge tone="failed">
          <XCircle className="size-3" aria-hidden /> MISCONFIGURED
        </Badge>
      );
    case "unavailable":
      return (
        <Badge tone="offline">
          <XCircle className="size-3" aria-hidden /> UNAVAILABLE
        </Badge>
      );
    case "disabled":
      return (
        <Badge tone="neutral">
          <Ban className="size-3" aria-hidden /> DISABLED
        </Badge>
      );
    default:
      return (
        <Badge tone="unknown">
          <HelpCircle className="size-3" aria-hidden /> UNKNOWN
        </Badge>
      );
  }
}
