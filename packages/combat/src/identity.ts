/**
 * 确定性敌我识别 —— AGENTS.md §0.1 的硬规则，零 AI 参与。
 *
 * 三条纪律全部在本文件落地：
 *   1. **白名单只能由用户显式配置。** `provenance` 必须逐字是
 *      `"operator-config"`；任何其它来源（含模型输出、运行时推断）在构造期
 *      就被拒绝，AI 无权增删条目。注册表构造后不可变，没有 add/remove。
 *   2. **白名单之外的一切玩家/实体一律视为敌对。** 认不出身份（用户名与 UUID
 *      都缺失、或实体类型未知）也算敌对，不会因为"看不清"而当成友军。
 *   3. **白名单按 serverProfileId 硬隔离。** A 服的白名单在 B 服无效；服号不
 *      匹配时**拒绝分类**（抛错），而不是把队友当敌人——这是 fail-closed 的
 *      正确方向：宁可不打，也不能误伤自己人。
 *
 * "视为敌对"只表示阵营判定，不等于此刻就要开打。是否真打由后续确定性存活
 * 逻辑决定（ThreatAnalyzer / TargetSelector / RetreatController）。
 */

export type CombatEntityKind =
  | "player"
  | "monster"
  | "animal"
  | "object"
  | "unknown";

export type CombatEntity = Readonly<{
  entityId: number;
  kind: CombatEntityKind;
  /** 显示用户名；离线服可为任意字符串，认不出时为 null。 */
  username: string | null;
  /** 实体 UUID，带不带连字符都接受；认不出时为 null。 */
  uuid: string | null;
}>;

/**
 * 白名单来源。**只有用户配置文件可以产生这个对象。**
 * `provenance` 是运行时闸门，不是文档注释：值不对就拒绝构造。
 */
export type CombatWhitelistSource = Readonly<{
  provenance: "operator-config";
  serverProfileId: string;
  /** 本 bot 自己的用户名，永远不会被判为敌对。 */
  selfUsername: string;
  usernames: readonly string[];
  uuids: readonly string[];
}>;

export type CombatAllegiance = "self" | "whitelisted" | "hostile" | "neutral";

export type CombatIdentityErrorCode =
  | "WHITELIST_PROVENANCE_REJECTED"
  | "WHITELIST_SERVER_PROFILE_REQUIRED"
  | "WHITELIST_SELF_REQUIRED"
  | "WHITELIST_ENTRY_INVALID"
  | "IDENTITY_SERVER_PROFILE_MISMATCH";

export class CombatIdentityError extends Error {
  readonly code: CombatIdentityErrorCode;

  constructor(code: CombatIdentityErrorCode, message: string) {
    super(message);
    this.name = "CombatIdentityError";
    this.code = code;
  }
}

const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
const UUID_PATTERN = /^[0-9a-f]{32}$/;

/** 用户名折叠大小写比较：白名单写 "Renna" 而进来的是 "renna" 时不能误伤。 */
function foldUsername(username: string): string {
  return username.toLowerCase();
}

/** UUID 去连字符并小写，两种常见写法等价。 */
function normalizeUuid(uuid: string): string {
  return uuid.replaceAll("-", "").toLowerCase();
}

export class CombatIdentityRegistry {
  readonly serverProfileId: string;

  private readonly selfUsername: string;
  private readonly usernames: ReadonlySet<string>;
  private readonly uuids: ReadonlySet<string>;

  private constructor(source: CombatWhitelistSource) {
    this.serverProfileId = source.serverProfileId;
    this.selfUsername = foldUsername(source.selfUsername);
    this.usernames = new Set(source.usernames.map(foldUsername));
    this.uuids = new Set(source.uuids.map(normalizeUuid));
  }

  /**
   * 唯一的构造入口。校验全部 fail-closed：任何一条不合格就拒绝，
   * 不做"跳过坏条目继续加载"——静默丢掉一个队友等于授权攻击他。
   */
  static fromOperatorConfig(
    source: CombatWhitelistSource,
  ): CombatIdentityRegistry {
    if (source.provenance !== "operator-config") {
      throw new CombatIdentityError(
        "WHITELIST_PROVENANCE_REJECTED",
        "敌我识别白名单只接受用户显式配置，AI 无权增删。",
      );
    }
    if (source.serverProfileId.trim().length === 0) {
      throw new CombatIdentityError(
        "WHITELIST_SERVER_PROFILE_REQUIRED",
        "白名单必须绑定 serverProfileId，禁止跨服复用。",
      );
    }
    if (!USERNAME_PATTERN.test(source.selfUsername)) {
      throw new CombatIdentityError(
        "WHITELIST_SELF_REQUIRED",
        "白名单必须声明本 bot 自己的合法用户名。",
      );
    }
    for (const username of source.usernames) {
      if (!USERNAME_PATTERN.test(username)) {
        throw new CombatIdentityError(
          "WHITELIST_ENTRY_INVALID",
          "白名单用户名不合法，拒绝加载整份白名单。",
        );
      }
    }
    for (const uuid of source.uuids) {
      if (!UUID_PATTERN.test(normalizeUuid(uuid))) {
        throw new CombatIdentityError(
          "WHITELIST_ENTRY_INVALID",
          "白名单 UUID 不合法，拒绝加载整份白名单。",
        );
      }
    }
    return new CombatIdentityRegistry(source);
  }

  get whitelistSize(): number {
    return this.usernames.size + this.uuids.size;
  }

  /**
   * 判定阵营。`serverProfileId` 是当前实际连接的服，必须与白名单绑定的服一致
   * ——不一致时抛错而不是猜，避免在没加载对应白名单的服上误伤队友。
   */
  classify(entity: CombatEntity, serverProfileId: string): CombatAllegiance {
    if (serverProfileId !== this.serverProfileId) {
      throw new CombatIdentityError(
        "IDENTITY_SERVER_PROFILE_MISMATCH",
        "白名单与当前服务器不匹配，拒绝进行敌我识别。",
      );
    }
    const folded = entity.username === null ? null : foldUsername(entity.username);
    if (folded !== null && folded === this.selfUsername) return "self";

    const normalized = entity.uuid === null ? null : normalizeUuid(entity.uuid);
    if (folded !== null && this.usernames.has(folded)) return "whitelisted";
    if (normalized !== null && this.uuids.has(normalized)) return "whitelisted";

    switch (entity.kind) {
      case "animal":
      case "object":
        return "neutral";
      // 玩家、怪物、以及**认不出类型的实体**都落在这里：白名单外一律敌对。
      default:
        return "hostile";
    }
  }

  isHostile(entity: CombatEntity, serverProfileId: string): boolean {
    return this.classify(entity, serverProfileId) === "hostile";
  }
}
