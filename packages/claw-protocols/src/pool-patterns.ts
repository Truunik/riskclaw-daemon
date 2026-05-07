import { parseAbi } from 'viem';
import type { ChainAdapter } from '@claw/core';

const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);

// Stable tokens by chainId — pools where both tokens are in this set are expected
// to trade near 1:1, deviation > 2% is a meaningful de-peg signal.
const STABLES_BY_CHAIN: Record<number, ReadonlySet<string>> = {
  4326: new Set([
    '0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7'.toLowerCase(), // USDm
    '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb'.toLowerCase(), // USDT0
    '0x2eA493384F42d7Ea78564F3EF4C86986eAB4a890'.toLowerCase(), // USDmY (yield-bearing variant — slightly looser tolerance ok for v1)
  ]),
};

const Q96 = 2n ** 96n;

export interface DePegRisk {
  riskBps: number;
  reasons: string[];
  /** absolute deviation from $1 in basis points (1% = 100 bps); null if not a stable pair */
  deviationBps: number | null;
}

/**
 * For UniV3-shape pools: implied price of token1 in token0 = (sqrtPriceX96 / 2^96)^2,
 * scaled by 10^(decimals0 - decimals1) to convert to human-readable units.
 *
 * Returns risk if the pair is recognized as stable/stable and the implied price drifts
 * beyond 2% from 1.0. Bp severity scales with the size of the deviation.
 */
export function stablePairDePegRisk(
  token0: string,
  token1: string,
  decimals0: number,
  decimals1: number,
  sqrtPriceX96: bigint,
  chainId: number,
): DePegRisk {
  const stables = STABLES_BY_CHAIN[chainId];
  if (!stables) return { riskBps: 0, reasons: [], deviationBps: null };
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  if (!stables.has(t0) || !stables.has(t1)) return { riskBps: 0, reasons: [], deviationBps: null };
  if (sqrtPriceX96 === 0n) return { riskBps: 0, reasons: [], deviationBps: null };

  // Convert sqrtPriceX96 to a Number-safe ratio. sqrtPrice ≤ 2^160, so squared exceeds
  // Number. Compute as ((sqrtPriceX96 << 32) / Q96)^2 / 2^64 in stages to keep precision.
  const ratio = Number(sqrtPriceX96) / Number(Q96);
  const priceRatio = ratio * ratio;
  const decimalsAdj = 10 ** (decimals0 - decimals1);
  const price = priceRatio * decimalsAdj;
  if (!isFinite(price) || price <= 0) return { riskBps: 0, reasons: [], deviationBps: null };

  const deviationBps = Math.round(Math.abs(price - 1) * 10_000);
  if (deviationBps < 200) return { riskBps: 0, reasons: [], deviationBps };

  let riskBps = 1500;
  if (deviationBps >= 2000) riskBps = 5000;
  else if (deviationBps >= 500) riskBps = 3000;

  return {
    riskBps,
    deviationBps,
    reasons: [
      `stable/stable pair ${(price >= 1 ? '+' : '')}${(price - 1).toFixed(4)} from $1.00 ` +
      `(${(deviationBps / 100).toFixed(2)}% off-peg)`,
    ],
  };
}

export interface TvlDrift {
  driftBps: number | null;
  reason: string | null;
}

/**
 * Read TVL drift over a custom lookback window.
 *   driftBps > 0 → token0 balance increased
 *   driftBps < 0 → token0 balance decreased (drain in progress)
 */
export async function readTvlDriftAt(
  poolAddress: string,
  token0: string,
  lookbackBlocks: bigint,
  chain: ChainAdapter,
): Promise<TvlDrift> {
  try {
    const latest = await chain.getBlockNumber();
    if (latest <= lookbackBlocks) return { driftBps: null, reason: null };
    const olderBlock = latest - lookbackBlocks;

    const balNow = await chain.readContract<bigint>({
      address: token0, abi: ERC20, functionName: 'balanceOf', args: [poolAddress],
    });
    const balOld = await chain.readContract<bigint>({
      address: token0, abi: ERC20, functionName: 'balanceOf', args: [poolAddress],
      blockNumber: olderBlock,
    });

    if (balOld === 0n) return { driftBps: null, reason: 'pool likely too new for TVL drift signal' };
    const driftBps = Number(((balNow - balOld) * 10_000n) / balOld);
    return { driftBps, reason: null };
  } catch (e) {
    return {
      driftBps: null,
      reason: `tvl-drift unavailable (likely non-archive RPC): ${(e as Error).message.split('\n')[0]}`,
    };
  }
}
