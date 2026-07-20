import type {
  BotStatusV1,
  BotTelemetryMessageV1,
} from "@minecraft-studio/protocol";
import type {
  AppLogger,
  MetricRecorder,
} from "@minecraft-studio/observability";

export type BotConnectionState = BotStatusV1["payload"]["connectionState"];
export type BotPosition = BotStatusV1["payload"]["position"];
export type BotMessageSink = (
  message: BotTelemetryMessageV1,
) => Promise<void> | void;

export type RuntimeLogger = AppLogger;
export type RuntimeMetrics = MetricRecorder;
