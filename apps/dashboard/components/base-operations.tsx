"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw, Sprout, Users, Warehouse } from "lucide-react";
import { FacilitySlotStrip } from "@/components/blueprint-grid";
import { BaseStatusBadge, StatusBadge } from "@/components/status-badges";
import { EmptyState } from "@/components/data-states";
import type { SharedStateView } from "@/lib/shared-state-client";

const phases = [
  ["SHELTER_MINIMAL_READY", "避难所"], ["BASE_SITE_RESERVED", "选址"], ["STARTER_BASE_ACTIVE", "基地主体"],
  ["FOOD_FACILITY_ACTIVE", "食物生产"], ["COBBLE_FACILITY_ACTIVE", "圆石生产"],
  ["VILLAGE_SOURCE_VERIFIED", "村民来源"], ["TRADING_HALL_ACTIVE", "交易所"],
] as const;
const productionLabels: Record<string, string> = { UNVERIFIED: "待验证", PRODUCING: "有收获", WAITING_GROWTH: "等待生长",
  WAITING_SEEDS: "缺少种子", WAITING_OBSERVATION: "等待区块", BLOCKED: "受阻" };
const availabilityLabels: Record<string, string> = { AVAILABLE: "已验证", UNVERIFIED: "待验证", DAMAGED: "受损", RECOVERING: "恢复中" };

export function BaseOperations({ view, failed, refresh }: { view: SharedStateView | null; failed: string | null; refresh(): Promise<void> }) {
  const [open, setOpen] = useState<string | null>(null);
  const [server, setServer] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const bases = view?.bases ?? [];
  const facilities = view?.facilities ?? [];
  const farmCount = facilities.filter((f) => f.production?.enabled).length;
  return <section className="baseOperations">
    <div className="baseSummary">
      <span><Warehouse size={17} aria-hidden />基地 <strong>{bases.length}</strong></span>
      <span><Sprout size={17} aria-hidden />生产农田 <strong>{farmCount}</strong></span>
      <span><Users size={17} aria-hidden />成员 <strong>{new Set(bases.flatMap((b) => b.memberBotIds ?? [])).size}</strong></span>
      <select aria-label="服务器筛选" value={server} onChange={(e) => setServer(e.target.value)}>
        <option value="">全部服务器</option>{[...new Set(bases.map((b) => b.serverProfileId))].map((id) => <option key={id}>{id}</option>)}
      </select>
      <button type="button" className="baseIconButton" title="刷新基地" aria-label="刷新基地" disabled={refreshing}
        onClick={() => { setRefreshing(true); void refresh().finally(() => setRefreshing(false)); }}><RefreshCw size={16} /></button>
    </div>
    {failed && <p role="status"><StatusBadge tone="warn">数据过期</StatusBadge> {failed}</p>}
    {bases.length === 0 && <EmptyState title="尚未登记基地" />}
    {bases.filter((base) => !server || base.serverProfileId === server).map((base) => {
      const expanded = open === base.id;
      const attached = facilities.filter((f) => f.baseId === base.id && f.serverProfileId === base.serverProfileId && f.dimension === base.dimension);
      return <article key={base.id} className="baseRecord">
        <header className="baseRecordHeader">
          <button type="button" className="baseIconButton" aria-expanded={expanded} aria-label={`${expanded ? "收起" : "展开"} ${base.name}`}
            title={expanded ? "收起基地" : "展开基地"} onClick={() => setOpen(expanded ? null : base.id)}>
            {expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
          </button>
          <div className="baseIdentity"><h2>{base.name}</h2><span>{base.serverProfileId} · {base.dimension}</span></div>
          <StatusBadge tone="muted">{base.source === "operator_adopted" ? "已加入" : "自建"}</StatusBadge>
          <BaseStatusBadge status={base.status} />
          <span className="baseMemberCount">{base.memberBotIds?.length ?? 0} 位成员</span>
        </header>
        <div className="basePhaseStrip">{phases.map(([key, label]) => {
          const fact = base.phaseFacts?.[key];
          const availability = fact?.availability ?? "UNVERIFIED";
          return <div key={key} className={`basePhase ${availability.toLowerCase()}`} title={fact ? `${fact.evidence} · ${new Date(fact.observedAt).toLocaleString()}` : "尚无验证记录"}>
            <span>{label}</span><strong>{availabilityLabels[availability] ?? availability}</strong>
          </div>;
        })}</div>
        {expanded && <div className="baseRecordDetail">
          <dl className="baseFacts">
            <div><dt>锚点</dt><dd>{base.anchor.x}, {base.anchor.y}, {base.anchor.z}</dd></div>
            <div><dt>成员</dt><dd>{base.memberBotIds?.join(", ") || "未分配"}</dd></div>
            <div><dt>结构记录</dt><dd>{base.blueprintId} · {base.placedCells} 格</dd></div>
            <div><dt>保护范围</dt><dd>{base.protectedBounds ? `${base.protectedBounds.min.x}, ${base.protectedBounds.min.y}, ${base.protectedBounds.min.z} 至 ${base.protectedBounds.max.x}, ${base.protectedBounds.max.y}, ${base.protectedBounds.max.z}` : "未登记"}</dd></div>
          </dl>
          <h3>生产与工作站</h3>
          {attached.length === 0 ? <p className="hint">暂无设施记录</p> : attached.map((facility) => {
            const production = facility.production;
            const stale = !production?.lastObservedAt || Date.now() - Date.parse(production.lastObservedAt) > 120_000;
            return <div className="baseFacility" key={facility.id}>
              <div className="baseFacilityHeading"><strong>{facility.facilityType === "crop_farm" ? "作物农田" : facility.facilityType}</strong>
                {production && <StatusBadge tone={production.status === "BLOCKED" ? "warn" : "muted"}>{stale ? "待复核" : productionLabels[production.status]}</StatusBadge>}
              </div>
              {production ? <dl className="baseFacts">
                <div><dt>作物</dt><dd>{production.input.crops.join(", ")}</dd></div>
                <div><dt>记录净收获</dt><dd>{production.samples.reduce((sum, sample) => sum + sample.netFood, 0)} 份 · {production.samples.length} 批</dd></div>
                <div><dt>最近核验</dt><dd>{production.lastObservedAt ? new Date(production.lastObservedAt).toLocaleTimeString() : "未执行"}</dd></div>
                <div><dt>下次检查</dt><dd>{production.enabled ? production.nextRunAtMs ? new Date(production.nextRunAtMs).toLocaleTimeString() : "待调度" : "已暂停"}</dd></div>
                {production.reason && <div><dt>阻塞原因</dt><dd>{production.reason}</dd></div>}
              </dl> : <FacilitySlotStrip slots={facility.slots} />}
            </div>;
          })}
        </div>}
      </article>;
    })}
  </section>;
}
