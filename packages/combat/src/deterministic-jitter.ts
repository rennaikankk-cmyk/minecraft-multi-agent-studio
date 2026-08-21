/**
 * 确定性 PRNG（xorshift32）—— 战斗模块共用的"类人化噪声"来源。
 *
 * 为什么不是 `Math.random`：§7 要求动作之间有人类量级的抖动，但单测必须能逐帧
 * 断言。种子相同 + 调用序列相同 = 输出完全相同，所以噪声既能打散固定周期，
 * 又不会让测试只能断言"大概"。
 *
 * **不用于任何安全用途**（不是密码学随机源）。
 */
export class DeterministicJitter {
  private state: number;

  constructor(seed: number) {
    // 0 是 xorshift 的不动点，换成任意非零常量。
    this.state = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0;
  }

  /** 返回 [-1, 1) 的确定性抖动系数。 */
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x | 0;
    return (x >>> 0) / 0x8000_0000 - 1;
  }
}
