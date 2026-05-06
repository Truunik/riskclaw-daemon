import type { Skill, SkillContext } from '@claw/core';
import {
  KumbayaDecoder,
  decodeKumbayaSwap,
  type DecodedSwap,
  type PoolRisk,
} from '@claw/protocols';

interface PreflightRequest {
  from: string;
  to: string;
  data: string;
  value?: string;
  afterTx?: string;
}

interface KumbayaContext {
  recognized: 'router' | 'swap';
  swap?: SerializedSwap;
  poolRisk?: PoolRisk;
}

interface SerializedSwap {
  kind: DecodedSwap['kind'];
  tokenIn: string;
  tokenOut: string;
  fee: number;
  recipient: string;
  amountIn?: string;
  amountOut?: string;
  amountOutMinimum?: string;
  amountInMaximum?: string;
  poolAddress: string;
}

interface PreflightResponse {
  decision: 'ALLOW' | 'WARN' | 'BLOCK';
  reasons: string[];
  riskScoreBps: number;
  attestation?: string;
  memoRoot?: string;
  kumbaya?: KumbayaContext;
}

function decisionFor(scoreBps: number): 'ALLOW' | 'WARN' | 'BLOCK' {
  if (scoreBps >= 8500) return 'BLOCK';
  if (scoreBps >= 5000) return 'WARN';
  return 'ALLOW';
}

function serializeSwap(s: DecodedSwap): SerializedSwap {
  return {
    kind: s.kind,
    tokenIn: s.tokenIn,
    tokenOut: s.tokenOut,
    fee: s.fee,
    recipient: s.recipient,
    poolAddress: s.poolAddress,
    ...(s.amountIn !== undefined && { amountIn: s.amountIn.toString() }),
    ...(s.amountOut !== undefined && { amountOut: s.amountOut.toString() }),
    ...(s.amountOutMinimum !== undefined && { amountOutMinimum: s.amountOutMinimum.toString() }),
    ...(s.amountInMaximum !== undefined && { amountInMaximum: s.amountInMaximum.toString() }),
  };
}

async function analyzeKumbaya(
  req: PreflightRequest,
  chainId: number,
  ctx: SkillContext,
): Promise<{ context: KumbayaContext; reasons: string[]; riskBps: number } | null> {
  if (!KumbayaDecoder.recognize(req.to, chainId)) return null;
  ctx.logger.info('kumbaya router detected', { to: req.to });

  const swap = decodeKumbayaSwap(req.data, chainId);
  if (!swap) {
    return {
      context: { recognized: 'router' },
      reasons: ['target is a Kumbaya router but calldata did not decode (multi-hop or unknown selector)'],
      riskBps: 1000,
    };
  }

  const reasons: string[] = [];
  let riskBps = 0;

  // Slippage protection check — the highest-impact MEV signal we can read locally.
  if (swap.amountOutMinimum !== undefined && swap.amountOutMinimum === 0n) {
    riskBps = Math.max(riskBps, 9000);
    reasons.push('amountOutMinimum=0 — zero slippage protection; vulnerable to MEV sandwich attacks');
  }
  if (swap.amountInMaximum !== undefined && swap.amountInMaximum > 0n && swap.amountOut !== undefined) {
    // exactOutput: if amountInMaximum is unbounded vs amountOut, similar risk
    // (rough heuristic — refine when QuoterV2 lookup is wired)
  }

  // Score the destination pool — V3 oracle, liquidity, TVL drift.
  const poolRisk = await KumbayaDecoder.scorePool(swap.poolAddress, chainId, ctx);
  reasons.push(...poolRisk.reasons.map(r => `pool ${swap.poolAddress.slice(0, 10)}…: ${r}`));
  riskBps = Math.max(riskBps, poolRisk.riskBps);

  return {
    context: { recognized: 'swap', swap: serializeSwap(swap), poolRisk },
    reasons,
    riskBps,
  };
}

async function check(req: PreflightRequest, ctx: SkillContext): Promise<PreflightResponse> {
  const chainId = Number(ctx.env.MEGAETH_CHAIN_ID ?? 6343);
  ctx.logger.info('preflight.check', { to: req.to, afterTx: req.afterTx, chainId });

  const reasons: string[] = [];
  let riskBps = 0;

  // 1. Protocol-specific deep analysis (calldata-aware) — always runs.
  const kumbaya = await analyzeKumbaya(req, chainId, ctx);
  if (kumbaya) {
    reasons.push(...kumbaya.reasons);
    riskBps = Math.max(riskBps, kumbaya.riskBps);
  }

  // 2. Simulation — a revert is one signal among many, not a short-circuit.
  let simulated: string | null = null;
  try {
    simulated = req.afterTx && ctx.chain.simulateAfter
      ? await ctx.chain.simulateAfter({ to: req.to, data: req.data, from: req.from, afterTx: req.afterTx })
      : await ctx.chain.call({ to: req.to, data: req.data, from: req.from });
  } catch (e) {
    const detail = (e as Error).message.split('\n')[0];
    // For an unrecognized target, a revert is a strong block signal.
    // For a recognized protocol (Kumbaya), a revert is often missing approval/balance — softer.
    if (kumbaya) {
      reasons.push(`simulation reverted (likely missing approval or balance): ${detail}`);
      riskBps = Math.max(riskBps, 5000);
    } else {
      reasons.push(`simulated tx would revert: ${detail}`);
      riskBps = Math.max(riskBps, 10_000);
    }
  }

  // 3. LLM/TEE analysis (when a compute adapter is wired).
  let attestation: string | undefined;
  let memoRoot: string | undefined;
  if (ctx.compute) {
    const analysis = await ctx.compute.analyze({
      subjectId: req.to,
      metrics: {
        simulated,
        kumbaya: kumbaya?.context ?? null,
        balanceDeltas: [],
        approvalsGranted: [],
        contractsCalled: [req.to],
      },
      prompt: 'evaluate this proposed transaction for user safety',
    });
    riskBps = Math.max(riskBps, analysis.riskScoreBps);
    reasons.push(...analysis.reasoning);
    attestation = analysis.attestation;
    if (ctx.storage) memoRoot = await ctx.storage.put(analysis.rawMemo, 'memo');
  }

  return {
    decision: decisionFor(riskBps),
    reasons: reasons.length ? reasons : ['no protocol decoder matched, no risk signals'],
    riskScoreBps: riskBps,
    ...(attestation !== undefined && { attestation }),
    ...(memoRoot !== undefined && { memoRoot }),
    ...(kumbaya && { kumbaya: kumbaya.context }),
  };
}

const skill: Skill = {
  manifest: {
    name: 'mega-preflight',
    description: 'Pre-flight risk co-pilot — simulates proposed user tx, decodes Kumbaya swaps, returns ALLOW/WARN/BLOCK with TEE-attested reasoning',
    chain: { id: 6343, name: 'MegaETH-testnet', rpc: 'https://carrot.megaeth.com/rpc' },
    adapters: { compute: 'tee', storage: 'content-addressed', signer: 'env', chain: 'evm-realtime' },
    streaming: false,
    handlers: ['check'],
  },
  handlers: {
    check: (req, ctx) => check(req as PreflightRequest, ctx),
  },
};

export default skill;
