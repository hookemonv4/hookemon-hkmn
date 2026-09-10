import {
  readAssociatedTokenAccount,
  readMplCoreAssetOwner,
} from '../../solana-rpc.mjs';

export async function verifiedHeldAssetOwner({ adapters, config, mint, assetKind }) {
  if (assetKind === 'spl') {
    if (adapters.solana.client.commitment !== 'finalized') {
      throw new Error('supplementary buyback requires finalized SPL ownership evidence');
    }
    const account = await readAssociatedTokenAccount(adapters.solana.client, config.accounts.solana, mint);
    if (!account.exists || account.amount <= 0n) {
      throw new Error('supplementary buyback requires a positive finalized card balance');
    }
    return config.accounts.solana;
  }
  if (assetKind !== 'mpl-core') throw new Error('supplementary buyback cannot verify the held asset kind');
  const owner = await readMplCoreAssetOwner(adapters.solana.client, mint, { commitment: 'finalized' });
  if (owner !== config.accounts.solana) {
    throw new Error('supplementary buyback production binding requires the operator to currently hold the finalized on-chain asset');
  }
  return owner;
}
