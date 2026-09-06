// Shared by L0 eating and ordinary inventory consumers. Surviving the next meal
// must not silently destroy the next planting cycle.
export class FoodReserves {
  private readonly seeds = new Map<string, number>();
  private readonly rations = new Map<string, number>();
  reserve(seed: string, seeds: number, food = 0): void {
    this.seeds.set(seed, Math.max(this.seeds.get(seed) ?? 0, seeds));
    this.rations.set(seed, Math.max(this.rations.get(seed) ?? 0, food));
  }
  seedCount(name: string): number { return this.seeds.get(name) ?? (["carrot", "potato", "wheat_seeds", "beetroot_seeds"].includes(name) ? 1 : 0); }
  keepCount(name: string): number { return this.seedCount(name) + (this.rations.get(name) ?? 0); }
  available(name: string, total: number, eating = false): number { return Math.max(0, total - (eating ? this.seedCount(name) : this.keepCount(name))); }
}
