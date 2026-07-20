import type {
  BotProtocolMessageV1,
  BotStatusV1,
} from "@minecraft-studio/protocol";

export type BotConnectionState = BotStatusV1["payload"]["connectionState"];
export type BotPosition = BotStatusV1["payload"]["position"];
export type BotMessageSink = (
  message: Exclude<BotProtocolMessageV1, { type: "bot.stop.command.v1" }>,
) => Promise<void> | void;

export type RuntimeLogger = {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
};
