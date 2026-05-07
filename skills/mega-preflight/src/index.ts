import type { Skill, SkillContext } from '@claw/core';
import {
  KumbayaDecoder,
  PrismDecoder,
  decodeKumbayaSwap,
  decodePrismSwap,
  extractV3Swaps,
  computeKumbayaPoolAddress,
  computePrismPoolAddress,
  KUMBAYA_ADDRESSES,
  PRISM_ADDRESSES,
  type DecodedSwap,
  type DecodedV3Swap,
  type PoolRisk,
  type SwapDecoder,
} from '@claw/protocols';

function deriveProtocolPool(
  protocolName: string,
  chainId: number,
  tokenIn: string,
  tokenOut: string,
  fee: number,
): string | null {
  if (protocolName === 'kumbaya') {
    const addr = KUMBAYA_ADDRESSES[chainId];
    return addr ? computeKumbayaPoolAddress(addr.factory, tokenIn, tokenOut, fee) : null;
  }
  if (protocolName === 'prism') {
    const addr = PRISM_ADDRESSES[chainId];
    return addr ? computePrismPoolAddress(addr.factory, tokenIn, tokenOut, fee) : null;
  }
  return null;
}

interface PreflightRequest {
  from: string;
  to: string;
  data: string;
  value?: string;
  afterTx?: string;
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

interface ProtocolContext {
  name: string;
  recognized: 'router' | 'swap';
  swap?: SerializedSwap;
  poolRisk?: PoolRisk;
}

interface PreflightResponse {
  decision: 'ALLOW' | 'WARN' | 'BLOCK';
  reasons: string[];
  riskScoreBps: number;
  attestation?: string;
  memoRoot?: string;
  protocol?: ProtocolContext;
  /** @deprecated kept for one cycle; use `protocol` instead */
  kumbaya?: ProtocolContext;
}

type DecodeFn = (data: string, chainId: number) => DecodedSwap | null;

const DECODERS: { decoder: SwapDecoder; decode: DecodeFn }[] = [
  { decoder: KumbayaDecoder, decode: decodeKumbayaSwap },
  { decoder: PrismDecoder, decode: decodePrismSwap as DecodeFn },
];

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

async function analyzeProtocol(
  req: PreflightRequest,
  chainId: number,
  ctx: SkillContext,
): Promise<{ context: ProtocolContext; reasons: string[]; riskBps: number } | null> {
  for (const { decoder, decode } of DECODERS) {
    if (!decoder.supports(chainId)) continue;
    if (!decoder.recognize(req.to, chainId)) continue;
    ctx.logger.info(`${decoder.name} router detected`, { to: req.to });

    // Path 1: direct SwapRouter02-style calldata (single swap, single pool).
    const directSwap = decode(req.data, chainId);
    if (directSwap) {
      const reasons: string[] = [];
      let riskBps = 0;
      if (directSwap.amountOutMinimum !== undefined && directSwap.amountOutMinimum === 0n) {
        riskBps = Math.max(riskBps, 9000);
        reasons.push('amountOutMinimum=0 — zero slippage protection; vulnerable to MEV sandwich attacks');
      }
      const poolRisk = await decoder.scorePool(directSwap.poolAddress, chainId, ctx);
      reasons.push(...poolRisk.reasons.map(r => `pool ${directSwap.poolAddress.slice(0, 10)}…: ${r}`));
      riskBps = Math.max(riskBps, poolRisk.riskBps);
      return {
        context: { name: decoder.name, recognized: 'swap', swap: serializeSwap(directSwap), poolRisk },
        reasons, riskBps,
      };
    }

    // Path 2: UniversalRouter command stream — multi-hop, multi-swap.
    const v3Swaps = extractV3Swaps(req.data);
    if (v3Swaps.length > 0) {
      return await analyzeUniversalRouterSwaps(decoder, v3Swaps, chainId, ctx);
    }

    // Recognized router but neither decode worked (e.g., V2_SWAP, PERMIT-only, or new opcode).
    return {
      context: { name: decoder.name, recognized: 'router' },
      reasons: [`target is a ${decoder.name} router but calldata did not decode (unknown command/selector or non-V3 swap)`],
      riskBps: 1000,
    };
  }
  return null;
}

async function analyzeUniversalRouterSwaps(
  decoder: SwapDecoder,
  v3Swaps: DecodedV3Swap[],
  chainId: number,
  ctx: SkillContext,
): Promise<{ context: ProtocolContext; reasons: string[]; riskBps: number }> {
  const reasons: string[] = [];
  let riskBps = 0;
  let firstSwap: SerializedSwap | undefined;
  let firstPoolRisk: PoolRisk | undefined;
  let totalHops = 0;

  for (const swap of v3Swaps) {
    totalHops += swap.hops.length;

    // Slippage protection: amountLimit==0 on EXACT_IN means "any amountOut accepted".
    if (swap.kind === 'V3_SWAP_EXACT_IN' && swap.amountLimit === 0n) {
      riskBps = Math.max(riskBps, 9000);
      reasons.push('amountOutMinimum=0 — zero slippage protection; vulnerable to MEV sandwich attacks');
    }

    for (const hop of swap.hops) {
      const poolAddr = deriveProtocolPool(decoder.name, chainId, hop.tokenIn, hop.tokenOut, hop.fee);
      if (!poolAddr) continue;
      const poolRisk = await decoder.scorePool(poolAddr, chainId, ctx);
      reasons.push(...poolRisk.reasons.map(r => `pool ${poolAddr.slice(0, 10)}…: ${r}`));
      riskBps = Math.max(riskBps, poolRisk.riskBps);

      if (!firstSwap) {
        firstPoolRisk = poolRisk;
        firstSwap = {
          kind: swap.kind === 'V3_SWAP_EXACT_IN' ? 'exactInputSingle' : 'exactOutputSingle',
          tokenIn: hop.tokenIn,
          tokenOut: hop.tokenOut,
          fee: hop.fee,
          recipient: swap.recipient,
          poolAddress: poolAddr,
          ...(swap.kind === 'V3_SWAP_EXACT_IN'
            ? { amountIn: swap.amountSpecified.toString(), amountOutMinimum: swap.amountLimit.toString() }
            : { amountOut: swap.amountSpecified.toString(), amountInMaximum: swap.amountLimit.toString() }),
        };
      }
    }
  }

  if (totalHops > 1 || v3Swaps.length > 1) {
    reasons.push(`UniversalRouter command stream: ${v3Swaps.length} V3 swap(s), ${totalHops} hop(s) total — first hop shown in 'swap'`);
  }

  return {
    context: { name: decoder.name, recognized: 'swap', swap: firstSwap, poolRisk: firstPoolRisk },
    reasons,
    riskBps,
  };
}

async function check(req: PreflightRequest, ctx: SkillContext): Promise<PreflightResponse> {
  const chainId = Number(ctx.env.MEGAETH_CHAIN_ID ?? 4326);
  ctx.logger.info('preflight.check', { to: req.to, afterTx: req.afterTx, chainId });

  const reasons: string[] = [];
  let riskBps = 0;

  // 1. Protocol-specific deep analysis (calldata-aware) — always runs.
  const protocol = await analyzeProtocol(req, chainId, ctx);
  if (protocol) {
    reasons.push(...protocol.reasons);
    riskBps = Math.max(riskBps, protocol.riskBps);
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
    // For a recognized protocol, a revert is often missing approval/balance — softer.
    if (protocol) {
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
        protocol: protocol?.context ?? null,
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
    ...(protocol && { protocol: protocol.context }),
    ...(protocol?.context.name === 'kumbaya' && { kumbaya: protocol.context }),
  };
}

const skill: Skill = {
  manifest: {
    name: 'mega-preflight',
    description: 'Pre-flight risk co-pilot — decodes proposed user tx (Kumbaya, Prism), simulates, returns ALLOW/WARN/BLOCK with TEE-attested reasoning',
    chain: { id: 4326, name: 'MegaETH-mainnet', rpc: 'https://mainnet.megaeth.com/rpc' },
    adapters: { compute: 'tee', storage: 'content-addressed', signer: 'env', chain: 'evm-realtime' },
    streaming: false,
    handlers: ['check'],
  },
  handlers: {
    check: (req, ctx) => check(req as PreflightRequest, ctx),
  },
};

export default skill;
