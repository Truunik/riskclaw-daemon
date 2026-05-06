import { encodeFunctionData, type Hex } from 'viem';
import type { SkillContext } from '@claw/core';
import type { PoolRisk, SwapDecoder } from '../types.ts';
import { ERC20_ABI } from '../erc20.ts';
import { KUMBAYA_ADDRESSES, kumbayaContracts } from './addresses.ts';
import { KUMBAYA_POOL_ABI } from './abi.ts';
import { KUMBAYA_SWAP_ROUTER_ABI } from './router-abi.ts';

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

const TVL_LOOKBACK_BLOCKS = 300n; // ~5 min on MegaETH 1s EVM blocks

async function readPoolState(poolAddress: string, ctx: SkillContext): Promise<PoolState> {
  const slot0 = await ctx.chain.readContract<readonly [bigint, number, number, number, number, number, boolean]>({
    address: poolAddress,
    abi: KUMBAYA_POOL_ABI,
    functionName: 'slot0',
  });
  const liquidity = await ctx.chain.readContract<bigint>({
    address: poolAddress,
    abi: KUMBAYA_POOL_ABI,
    functionName: 'liquidity',
  });
  const token0 = await ctx.chain.readContract<string>({
    address: poolAddress,
    abi: KUMBAYA_POOL_ABI,
    functionName: 'token0',
  });
  const token1 = await ctx.chain.readContract<string>({
    address: poolAddress,
    abi: KUMBAYA_POOL_ABI,
    functionName: 'token1',
  });
  const fee = await ctx.chain.readContract<number>({
    address: poolAddress,
    abi: KUMBAYA_POOL_ABI,
    functionName: 'fee',
  });

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

async function readTvlDriftBps(
  state: PoolState,
  poolAddress: string,
  ctx: SkillContext,
): Promise<{ tvlDriftBps: number | null; reason: string | null }> {
  try {
    const latest = await ctx.chain.getBlockNumber();
    if (latest <= TVL_LOOKBACK_BLOCKS) return { tvlDriftBps: null, reason: null };
    const olderBlock = latest - TVL_LOOKBACK_BLOCKS;

    const balNow0 = await ctx.chain.readContract<bigint>({
      address: state.token0,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [poolAddress],
    });
    const balOld0 = await ctx.chain.readContract<bigint>({
      address: state.token0,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [poolAddress],
      blockNumber: olderBlock,
    });

    if (balOld0 === 0n) return { tvlDriftBps: null, reason: 'pool likely too new for TVL drift signal' };

    const driftSignedBps = Number(((balNow0 - balOld0) * 10_000n) / balOld0);
    return { tvlDriftBps: driftSignedBps, reason: null };
  } catch (e) {
    return { tvlDriftBps: null, reason: `tvl-drift unavailable (likely non-archive RPC): ${(e as Error).message.split('\n')[0]}` };
  }
}

function scoreFromState(
  state: PoolState,
  tvl: { tvlDriftBps: number | null; reason: string | null },
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

  if (tvl.tvlDriftBps !== null) {
    if (tvl.tvlDriftBps <= -3000) {
      riskBps += Math.min(5000, Math.abs(tvl.tvlDriftBps));
      reasons.push(`TVL token0 dropped ${Math.abs(tvl.tvlDriftBps)} bps in last ${TVL_LOOKBACK_BLOCKS} blocks (~5min)`);
    } else if (tvl.tvlDriftBps <= -1000) {
      riskBps += 1000;
      reasons.push(`TVL token0 down ${Math.abs(tvl.tvlDriftBps)} bps in last ${TVL_LOOKBACK_BLOCKS} blocks`);
    }
  } else if (tvl.reason) {
    reasons.push(tvl.reason);
  }

  return {
    riskBps: Math.min(10_000, riskBps),
    reasons,
    components: {
      tvlDriftBps: tvl.tvlDriftBps,
      spreadBps: null,
      inactiveLiquidity,
      oracleHealthBps,
    },
  };
}

export const KumbayaDecoder: SwapDecoder = {
  name: 'kumbaya',

  supports(chainId: number): boolean {
    return chainId in KUMBAYA_ADDRESSES;
  },

  recognize(target: string, chainId: number): boolean {
    return kumbayaContracts(chainId).has(target.toLowerCase());
  },

  async scorePool(poolAddress: string, chainId: number, ctx: SkillContext): Promise<PoolRisk> {
    if (!this.supports(chainId)) {
      return {
        protocol: 'kumbaya',
        poolAddress,
        riskBps: 0,
        reasons: [`kumbaya not deployed on chainId ${chainId}`],
        components: { tvlDriftBps: null, spreadBps: null, inactiveLiquidity: null, oracleHealthBps: null },
      };
    }
    const state = await readPoolState(poolAddress, ctx);
    const tvl = await readTvlDriftBps(state, poolAddress, ctx);
    const { riskBps, reasons, components } = scoreFromState(state, tvl);
    return { protocol: 'kumbaya', poolAddress, riskBps, reasons, components };
  },
};

export { computeKumbayaPoolAddress, decodeKumbayaSwap, type DecodedSwap } from './decode.ts';

export interface BuildSwapCalldataInput {
  pool: string;
  amountIn: bigint;
  amountOutMinimum: bigint;
  recipient: string;
  chainId: number;
  ctx: SkillContext;
}

export interface BuiltSwapCalldata {
  router: string;
  data: Hex;
  tokenIn: string;
  tokenOut: string;
  fee: number;
}

export async function buildExactInputSingleCalldata(
  input: BuildSwapCalldataInput,
): Promise<BuiltSwapCalldata> {
  const addr = KUMBAYA_ADDRESSES[input.chainId];
  if (!addr) throw new Error(`Kumbaya not deployed on chainId ${input.chainId}`);

  const tokenIn = await input.ctx.chain.readContract<string>({
    address: input.pool,
    abi: KUMBAYA_POOL_ABI,
    functionName: 'token0',
  });
  const tokenOut = await input.ctx.chain.readContract<string>({
    address: input.pool,
    abi: KUMBAYA_POOL_ABI,
    functionName: 'token1',
  });
  const fee = await input.ctx.chain.readContract<number>({
    address: input.pool,
    abi: KUMBAYA_POOL_ABI,
    functionName: 'fee',
  });

  const data = encodeFunctionData({
    abi: KUMBAYA_SWAP_ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [{
      tokenIn: tokenIn as Hex,
      tokenOut: tokenOut as Hex,
      fee,
      recipient: input.recipient as Hex,
      amountIn: input.amountIn,
      amountOutMinimum: input.amountOutMinimum,
      sqrtPriceLimitX96: 0n,
    }],
  });

  return { router: addr.router02, data, tokenIn, tokenOut, fee };
}
