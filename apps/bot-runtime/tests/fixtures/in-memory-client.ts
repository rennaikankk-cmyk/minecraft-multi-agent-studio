import { WorldAssetAuthority, InMemoryWorkstationRegistry } from '@minecraft-studio/asset-policy';
import { MineflayerBotClient as RuntimeClient } from "../../src/mineflayer-client.js";
export * from "../../src/mineflayer-client.js";

/** Explicit isolated authority injection; production always uses Coordinator RPC. */
export class MineflayerBotClient extends RuntimeClient {
  constructor(...args: ConstructorParameters<typeof RuntimeClient>) {
    const assets = new WorldAssetAuthority();
    super(args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7],
      args[8] ?? new InMemoryWorkstationRegistry(), args[9] ?? { assets, workAreas: assets.workAreas }, args[10]);
  }
}
