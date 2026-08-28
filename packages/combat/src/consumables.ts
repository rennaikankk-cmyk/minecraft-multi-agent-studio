// ---------------------------------------------------------------------------
// CombatConsumables —— 战斗消耗品（盾牌格挡 / 药水 / 金苹果）。
//
// 原版机制（无反作弊涉及，纯交互时序）：
// - 盾牌：副手持有 + activateItem(true) 开始格挡；格挡中减伤 100%
//   （近战/箭）但减速。攻击间隙格挡 = "turtling"；收到爆炸前格挡减半伤。
// - 金苹果：吃 1.6s → 吸收 IV 2:00 + 生命恢复 II 5s。战斗前预吃。
// - 药水（治疗/力量/速度）：投掷即生效（对自己需要向下丢）。
// ---------------------------------------------------------------------------

export type ConsumableAction =
  | Readonly<{ kind: "SHIELD_BLOCK"; durationMs: number }>
  | Readonly<{ kind: "SHIELD_RELEASE" }>
  | Readonly<{ kind: "EAT_GOLDEN_APPLE" }>
  | Readonly<{ kind: "THROW_POTION"; potionName: string }>;

export type CombatBotConsumableView = {
  inventory?: {
    items?: () => readonly Readonly<{ name: string; type: unknown }>[];
  };
  heldItem?: unknown;
  equip?: (item: unknown, destination: string) => Promise<void>;
  activateItem?: (offhand?: boolean) => void;
  deactivateItem?: () => void;
  consume?: () => Promise<void>;
  look?: (yaw: number, pitch: number, force?: boolean) => Promise<void>;
  entity?: { position?: { x: number; y: number; z: number }; pitch?: number } | null;
};

/**
 * 盾牌格挡决策：以下情形应举盾——
 * 1. 目标持弓且在瞄准自己（箭飞行中）
 * 2. 敌方水晶刚放置且爆炸窗口内
 * 3. 自身攻击冷却未满（间隙格挡 = 免费减伤）
 */
export function shouldBlockShield(context: Readonly<{
  attackCooldownRatio: number;
  rangedThreatIncoming: boolean;
  crystalThreatNearby: boolean;
  usingItem: boolean;
}>): boolean {
  if (context.usingItem) return false; // 已在使用物品（吃/喝）不能举盾
  if (context.rangedThreatIncoming || context.crystalThreatNearby) return true;
  return context.attackCooldownRatio < 0.5; // 冷却前半段举盾
}

/** 是否应在战斗前预吃金苹果（血量不满或无吸收效果）。 */
export function shouldEatGoldenApple(context: Readonly<{
  health: number;
  maxHealth: number;
  hasAbsorption: boolean;
  goldenApples: number;
}>): boolean {
  if (context.goldenApples <= 0) return false;
  if (context.hasAbsorption) return false;
  return context.health < context.maxHealth * 0.7;
}

/** 执行举盾（equip 副手 → activateItem offhand）。 */
export async function startShieldBlock(
  bot: CombatBotConsumableView,
): Promise<boolean> {
  const getItems = bot.inventory?.items;
  const items = getItems ? getItems.call(bot.inventory) : [];
  const shield = items.find((item) => item.name === "shield");
  const equip = bot.equip;
  const activate = bot.activateItem;
  if (!shield || !equip || !activate) return false;
  await equip!(shield.type, "off-hand");
  activate!(true); // off-hand use = 举盾
  return true;
}

/** 收盾（deactivateItem）。 */
export function stopShieldBlock(bot: CombatBotConsumableView): void {
  bot.deactivateItem?.();
}

/** 吃金苹果（equip 主手 → consume）。 */
export async function eatGoldenApple(
  bot: CombatBotConsumableView,
): Promise<boolean> {
  const getItems = bot.inventory?.items;
  const items = getItems ? getItems.call(bot.inventory) : [];
  const gapple = items.find(
    (item) => item.name === "golden_apple" || item.name === "enchanted_golden_apple",
  );
  const equip = bot.equip;
  const consume = bot.consume;
  if (!gapple || !equip || !consume) return false;
  await equip!(gapple.type, "hand");
  await consume!();
  return true;
}

/**
 * 对自己投掷药水（向下看 90° → activateItem → 恢复视角）。
 * potionName 例: "healing_potion"/"strength_potion"/"swiftness_potion"。
 */
export async function throwPotionAtSelf(
  bot: CombatBotConsumableView,
  potionName: string,
): Promise<boolean> {
  const getItems = bot.inventory?.items;
  const items = getItems ? getItems.call(bot.inventory) : [];
  const potion = items.find(
    (item) => item.name === potionName || item.name === "splash_" + potionName,
  );
  const equip = bot.equip;
  const activate = bot.activateItem;
  const look = bot.look;
  if (!potion || !equip || !activate || !look || !bot.entity?.position) {
    return false;
  }
  await equip!(potion.type, "hand");
  const originalPitch = bot.entity.pitch ?? 0;
  await look!(0, Math.PI / 2, true); // pitch 90° = 向下
  activate!(false);
  await new Promise((resolve) => setTimeout(resolve, 300)); // 投掷动画
  await look!(0, originalPitch, true);
  return true;
}
