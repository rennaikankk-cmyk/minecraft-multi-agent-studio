/**
 * 兼容层：实现已上收至 @minecraft-studio/db-pool（task-system 与 world-memory
 * 的结构级拷贝单点化）。本文件仅保留既有公共名；调用方零改动。
 * 注意：错误码取值由 WORLD_MEMORY_POSTGRES_* 统一为 POSTGRES_*（全仓无字符
 * 串匹配消费者；health.errorCode 的语义不变）。
 */
import { PgPoolAdapter } from "@minecraft-studio/db-pool";

export {
  PG_CONNECTION_TIMEOUT_MS as WORLD_MEMORY_PG_CONNECTION_TIMEOUT_MS,
  PG_QUERY_TIMEOUT_MS as WORLD_MEMORY_PG_QUERY_TIMEOUT_MS,
  PG_STATEMENT_TIMEOUT_MS as WORLD_MEMORY_PG_STATEMENT_TIMEOUT_MS,
} from "@minecraft-studio/db-pool";
export { PgPoolAdapterError as PgWorldMemoryPoolAdapterError } from "@minecraft-studio/db-pool";
export type { PgPoolErrorCode as PgWorldMemoryPoolErrorCode, PgPoolHealth as PgWorldMemoryPoolHealth } from "@minecraft-studio/db-pool";

export class PgWorldMemoryPoolAdapter extends PgPoolAdapter {}
