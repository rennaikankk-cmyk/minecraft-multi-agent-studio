/**
 * 兼容层：实现已上收至 @minecraft-studio/db-pool（task-system 与 world-memory
 * 的结构级拷贝单点化）。本文件仅保留既有公共名；调用方零改动。
 * 注意：错误码取值统一为 POSTGRES_* 前缀（原即如此），全仓无字符串匹配消费者。
 */
import { PgPoolAdapter } from "@minecraft-studio/db-pool";

export {
  PG_CONNECTION_TIMEOUT_MS,
  PG_QUERY_TIMEOUT_MS,
  PG_STATEMENT_TIMEOUT_MS,
} from "@minecraft-studio/db-pool";
export { PgPoolAdapterError as PgTaskPoolAdapterError } from "@minecraft-studio/db-pool";
export type { PgPoolErrorCode as PgTaskPoolErrorCode, PgPoolHealth as PgTaskPoolHealth } from "@minecraft-studio/db-pool";

export class PgTaskPoolAdapter extends PgPoolAdapter {}
