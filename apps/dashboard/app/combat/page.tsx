import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "作战 · Minecraft Multi-Agent Studio",
};

const roles = [
  {
    tag: "SCOUT",
    name: "侦察",
    description:
      "集群的眼睛。地狱顶层公路巡逻、基岩顶探测、扫描已激活地狱门定位敌方基地嫌疑点，坐标写入共享世界记忆。",
  },
  {
    tag: "RAIDER",
    name: "突袭",
    description:
      "对已核实目标发起打击：破基地、清储备。目标由战略层下发，交战对象由确定性白名单判定。",
  },
  {
    tag: "DEFENDER",
    name: "防御",
    description:
      "基地警戒与反制。对抗敌方侦察的选址硬规则（离轴、避对称坐标、无主世界门）由建造角色执行，防御角色负责暴露后的应对。",
  },
  {
    tag: "COMBATANT",
    name: "战斗",
    description:
      "水晶 PvP、图腾管理、换甲。战斗动作 100% 确定性反射层执行，AI 只决定是否交战与撤退阈值。",
  },
  {
    tag: "INFRA",
    name: "建造与生产",
    description:
      "战争经济引擎。从裸装冷启动到量产末影水晶的自举科技树；库存水位线驱动战备物资产能。",
  },
  {
    tag: "LOGISTICS",
    name: "后勤",
    description:
      "预置补货套件、隐蔽转运、3-2-1 分散储备。让“死一个 bot 掉一套装”的损失可快速补充。",
  },
] as const;

export default function CombatPage() {
  return (
    <main className="shell">
      <header className="pageHeader">
        <p className="eyebrow">CONTROL PLANE · COMBAT</p>
        <h2>作战指挥</h2>
        <p>
          六类作战角色的设计定位（静态设计文案，来源：作战设计文档与战术参考库）。
          运行时作战数据与指挥操作需等待后续里程碑的后端接入。
        </p>
      </header>

      <div className="roleGrid" data-testid="combat-role-grid">
        {roles.map((role) => (
          <article className="roleCard" key={role.tag}>
            <span className="roleTag">{role.tag}</span>
            <h4>{role.name}</h4>
            <p>{role.description}</p>
          </article>
        ))}
      </div>

      <section className="notConnectedPanel" data-testid="combat-not-connected">
        <strong>运行时数据未接入</strong>
        <p>以下能力需等待对应里程碑的后端完成，本页不展示任何模拟作战数据：</p>
        <ul>
          <li>交战白名单管理（确定性敌我识别，白名单仅限用户配置）—— 待 M3 战斗反射层</li>
          <li>角色分配与战场态势 —— 待 M4 多角色协调</li>
          <li>共享世界记忆（嫌疑基地标记、己方隐蔽点）—— 待 P2.1 长期记忆</li>
        </ul>
      </section>
    </main>
  );
}
