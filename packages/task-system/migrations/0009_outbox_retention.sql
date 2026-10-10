BEGIN;

-- 0009_outbox_retention：outbox 保留清扫（purgeDeliveredOutbox）的支撑索引。
-- 只索引 delivered 行（清扫 WHERE 的主体：status='delivered' AND
-- delivered_at < TTL），pending/claimed 行不占空间。任务终态的过滤由
-- studio_tasks 主键 JOIN 完成，不需要额外索引。
CREATE INDEX IF NOT EXISTS studio_task_outbox_delivered_retention_idx
  ON studio_task_outbox (delivered_at)
  WHERE status = 'delivered';

COMMIT;
