import { encodeAbiParameters, getCreate2Address, keccak256, type Hex } from 'viem';
import type { SkillContext } from '@claw/core';
import type { PoolRisk, SwapDecoder } from '../types.ts';
import { PRISM_ADDRESSES, PRISM_POOL_INIT_CODE_HASH, prismContracts } from './addresses.ts';
import { PRISM_POOL_ABI } from './abi.ts';
import { poolTokenPatternRisk, getTokenDecimals } from '../token-patterns.ts';
import { readTvlDriftAt, stablePairDePegRisk, type TvlDrift, type DePegRisk } from '../pool-patterns.ts';

interface PoolState {
  sqrtPriceX96: bigint;
  tick: number;
  observationCardinality: number;
  unlocked: boolean;
  liquidity: bigint;
  token0: string;
  token1: string;
  fee: number;
}

const TVL_LOOKBACK_SHORT = 300n;   // ~5 min on 1s EVM blocks
const TVL_LOOKBACK_MEDIUM = 7200n; // ~2 hours — catches slow drains

export function computePrismPoolAddress(
  factory: string,
  tokenA: string,
  tokenB: string,
  fee: number,
): string {
  const [t0, t1] = tokenA.toLowerCase() < tokenB.toLowerCase()
    ? [tokenA, tokenB]
    : [tokenB, tokenA];
  const salt = keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }],
      [t0 as Hex, t1 as Hex, fee],
    ),
  );
  return getCreate2Address({
    from: factory as Hex,
    salt,
    bytecodeHash: PRISM_POOL_INIT_CODE_HASH as Hex,
  });
}

async function readPoolState(poolAddress: string, ctx: SkillContext): Promise<PoolState> {
  const [slot0, liquidity, token0, token1, fee] = await Promise.all([
    ctx.chain.readContract<readonly [bigint, number, number, number, number, number, boolean]>({
      address: poolAddress, abi: PRISM_POOL_ABI, functionName: 'slot0',
    }),
    ctx.chain.readContract<bigint>({ address: poolAddress, abi: PRISM_POOL_ABI, functionName: 'liquidity' }),
    ctx.chain.readContract<string>({ address: poolAddress, abi: PRISM_POOL_ABI, functionName: 'token0' }),
    ctx.chain.readContract<string>({ address: poolAddress, abi: PRISM_POOL_ABI, functionName: 'token1' }),
    ctx.chain.readContract<number>({ address: poolAddress, abi: PRISM_POOL_ABI, functionName: 'fee' }),
  ]);
  return {
    sqrtPriceX96: slot0[0],
    tick: slot0[1],
    observationCardinality: slot0[3],
    unlocked: slot0[6],
    liquidity,
    token0,
    token1,
    fee,
  };
}

function scoreFromState(
  state: PoolState,
  tvlShort: TvlDrift,
  tvlMedium: TvlDrift,
  tokenPattern: { riskBps: number; reasons: string[] },
  dePeg: DePegRisk,
): { riskBps: number; reasons: string[]; components: PoolRisk['components'] } {
  const reasons: string[] = [];
  let riskBps = 0;

  if (!state.unlocked) {
    riskBps += 2000;
    reasons.push('pool reentrancy lock engaged at read-time');
  }

  const inactiveLiquidity = state.liquidity < 1_000n;
  if (inactiveLiquidity) {
    riskBps += 5000;
    reasons.push(`liquidity is ${state.liquidity.toString()} (effectively dead)`);
  } else if (state.liquidity < 1_000_000n) {
    riskBps += 2000;
    reasons.push(`liquidity is thin: ${state.liquidity.toString()}`);
  }

  let oracleHealthBps: number | null = null;
  if (state.observationCardinality === 0) {
    oracleHealthBps = 0;
    riskBps += 1500;
    reasons.push('no oracle observations — TWAP unavailable');
  } else if (state.observationCardinality < 10) {
    oracleHealthBps = state.observationCardinality * 1000;
    riskBps += 500;
    reasons.push(`shallow oracle cardinality: ${state.observationCardinality}`);
  } else {
    oracleHealthBps = 10_000;
  }

  if (tvlShort.driftBps !== null) {
    if (tvlShort.driftBps <= -3000) {
      riskBps += Math.min(5000, Math.abs(tvlShort.driftBps));
      reasons.push(`TVL token0 dropped ${Math.abs(tvlShort.driftBps)} bps in last ${TVL_LOOKBACK_SHORT} blocks (~5min)`);
    } else if (tvlShort.driftBps <= -1000) {
      riskBps += 1000;
      reasons.push(`TVL token0 down ${Math.abs(tvlShort.driftBps)} bps in last ${TVL_LOOKBACK_SHORT} blocks`);
    }
  } else if (tvlShort.reason) {
    reasons.push(tvlShort.reason);
  }

  if (tvlMedium.driftBps !== null && tvlMedium.driftBps <= -2000) {
    riskBps += Math.min(3000, Math.abs(tvlMedium.driftBps) / 2);
    reasons.push(`TVL token0 down ${Math.abs(tvlMedium.driftBps)} bps over last ${TVL_LOOKBACK_MEDIUM} blocks (~2h slow drain)`);
  }

  if (tokenPattern.riskBps > 0) {
    riskBps += tokenPattern.riskBps;
    reasons.push(...tokenPattern.reasons);
  }

  if (dePeg.riskBps > 0) {
    riskBps += dePeg.riskBps;
    reasons.push(...dePeg.reasons);
  }

  return {
    riskBps: Math.min(10_000, riskBps),
    reasons,
    components: {
      tvlDriftBps: tvlShort.driftBps,
      tvlDriftMediumBps: tvlMedium.driftBps,
      spreadBps: null,
      inactiveLiquidity,
      oracleHealthBps,
      tokenPatternBps: tokenPattern.riskBps > 0 ? tokenPattern.riskBps : null,
      dePegDeviationBps: dePeg.deviationBps,
    },
  };
}

export const PrismDecoder: SwapDecoder = {
  name: 'prism',

  supports(chainId: number): boolean {
    return chainId in PRISM_ADDRESSES;
  },

  recognize(target: string, chainId: number): boolean {
    return prismContracts(chainId).has(target.toLowerCase());
  },

  async scorePool(poolAddress: string, chainId: number, ctx: SkillContext): Promise<PoolRisk> {
    if (!this.supports(chainId)) {
      return {
        protocol: 'prism',
        poolAddress,
        riskBps: 0,
        reasons: [`prism not deployed on chainId ${chainId}`],
        components: {
          tvlDriftBps: null, tvlDriftMediumBps: null, spreadBps: null,
          inactiveLiquidity: null, oracleHealthBps: null,
          tokenPatternBps: null, dePegDeviationBps: null,
        },
      };
    }
    const state = await readPoolState(poolAddress, ctx);
    const [tvlShort, tvlMedium, tokenPattern, dec0, dec1] = await Promise.all([
      readTvlDriftAt(poolAddress, state.token0, TVL_LOOKBACK_SHORT, ctx.chain),
      readTvlDriftAt(poolAddress, state.token0, TVL_LOOKBACK_MEDIUM, ctx.chain),
      poolTokenPatternRisk(state.token0, state.token1, ctx.chain),
      getTokenDecimals(state.token0, ctx.chain),
      getTokenDecimals(state.token1, ctx.chain),
    ]);
    const dePeg = (dec0 !== null && dec1 !== null)
      ? stablePairDePegRisk(state.token0, state.token1, dec0, dec1, state.sqrtPriceX96, chainId)
      : { riskBps: 0, reasons: [], deviationBps: null };

    const { riskBps, reasons, components } = scoreFromState(state, tvlShort, tvlMedium, tokenPattern, dePeg);
    return { protocol: 'prism', poolAddress, riskBps, reasons, components };
  },
};
