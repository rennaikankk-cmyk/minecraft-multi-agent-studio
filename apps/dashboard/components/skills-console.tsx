import {
  builtinSkillStatusCatalog,
  skillSystemV1Manifest,
} from "@minecraft-studio/skills";

// 服务端组件：Manifest 是纯静态推导数据，无需客户端交互/轮询。
// 展示纪律（capability honesty）：
//   - 状态/成熟度直接取推导值，本组件不得出现第二套"看起来更好"的文案；
//   - 缺证据（无真实场景 PASS）必须可见，而不是被绿隐藏。

const MATURITY_TONE: Record<string, string> = {
  L5: "text-emerald-400",
  L4: "text-emerald-400",
  L3: "text-sky-400",
  L2: "text-amber-400",
  L1: "text-muted-foreground",
  L0: "text-red-400",
};

const STATUS_TONE: Record<string, string> = {
  Stable: "text-emerald-400",
  Partial: "text-sky-400",
  Experimental: "text-amber-400",
  Broken: "text-red-400",
  Untested: "text-muted-foreground",
};

function SummaryCard({ label, value, tone }: { label: string; value: string | number; tone?: string | undefined }) {
  return (
    <div className="metricCard">
      <p className="text-[11px] uppercase tracking-[0.12em] text-subtle-foreground">{label}</p>
      <p className={`text-2xl font-semibold ${tone}`}>{value}</p>
    </div>
  );
}

export function SkillsConsole() {
  const manifest = skillSystemV1Manifest;
  const pendingReal = manifest.skills.filter((s) => s.maturityLevel === "L3" || s.maturityLevel === "L2");
  const statusById = new Map(builtinSkillStatusCatalog.map((e) => [e.skillId, e]));

  return (
    <section className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <SummaryCard label="技能总数" value={manifest.totalSkills} />
        {(["L2", "L3", "L4", "L5"] as const).map((level) => (
          <SummaryCard key={level} label={level} value={manifest.maturitySummary[level] ?? 0} tone={MATURITY_TONE[level]} />
        ))}
      </div>

      <p className="text-xs text-subtle-foreground">
        成熟度阶梯：L1 注册 / L2 能力+单测 / L3 目标可达+typed progress+恢复 / L4 真实隔离服场景 / L5 多版本。
        真实场景 PASS 记录在 <code>scenario-results</code> 账本——账本没有的版本不会出现在下表。
        当前缺真实服证据的技能 <strong>{pendingReal.length}</strong> 个（如实展示，不算缺陷：是待跑的账）。
      </p>

      <div className="panel overflow-x-auto">
        <table className="dataTable w-full text-xs">
          <thead>
            <tr>
              <th>技能</th>
              <th>家族</th>
              <th>成熟度</th>
              <th>状态</th>
              <th>Planner</th>
              <th>能力</th>
              <th>进度契约</th>
              <th>已验证版本</th>
              <th>真实场景</th>
              <th>待过闸</th>
            </tr>
          </thead>
          <tbody>
            {manifest.skills.map((skill) => {
              const status = statusById.get(skill.skillId);
              const pending = status?.pendingGates ?? [];
              return (
                <tr key={skill.skillId}>
                  <td className="font-mono">{skill.skillId}</td>
                  <td>{skill.family}</td>
                  <td className={MATURITY_TONE[skill.maturityLevel] ?? ""}>{skill.maturityLevel}</td>
                  <td className={STATUS_TONE[skill.status] ?? ""}>{skill.status}</td>
                  <td>{skill.plannerReachability === "both" ? "确定性+LLM" : skill.plannerReachability === "deterministic" ? "确定性" : "LLM"}</td>
                  <td className="max-w-56 truncate" title={skill.runtimeCapabilities.join(", ")}>
                    {skill.runtimeCapabilities.length === 0 ? "—" : skill.runtimeCapabilities.join(", ")}
                  </td>
                  <td>{skill.progressContract ?? "—"}</td>
                  <td>{skill.verifiedMinecraftVersions.length === 0 ? <span className="text-muted-foreground">未验证</span> : skill.verifiedMinecraftVersions.join(", ")}</td>
                  <td>{skill.realScenarioIds.length === 0 ? "—" : skill.realScenarioIds.length}</td>
                  <td className="text-muted-foreground">{pending.length === 0 ? "—" : pending.join(" · ")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <details className="panel p-3 text-xs">
        <summary className="cursor-pointer font-medium">限制与已知边界（per skill）</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-subtle-foreground">
          {manifest.skills
            .filter((skill) => skill.limitations.length > 0)
            .flatMap((skill) =>
              skill.limitations.map((limitation) => (
                <li key={`${skill.skillId}:${limitation}`}>
                  <span className="font-mono text-foreground">{skill.skillId}</span> — {limitation}
                </li>
              )),
            )}
        </ul>
      </details>

      <p className="text-[11px] text-subtle-foreground">
        Manifest 源：<code>{manifest.generatedFrom}</code>（schema {manifest.schemaVersion}）。
        CI gates 保证本页与注册表/EVIDENCE/场景账本零漂移。
      </p>
    </section>
  );
}
