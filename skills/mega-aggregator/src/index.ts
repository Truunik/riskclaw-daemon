import type { Skill, SkillContext } from '@claw/core';
import { KumbayaDecoder, type PoolRisk, type SwapDecoder } from '@claw/protocols';

const DECODERS: SwapDecoder[] = [KumbayaDecoder];

interface PoolHop {
  address: string;
  protocol: string;
  fromToken: string;
  toToken: string;
}

interface ScoreRequest {
  amountIn: string;
  hops: PoolHop[];
}

interface ScoreResponse {
  routeRiskBps: number;
  recommendation: 'ALLOW' | 'WARN' | 'BLOCK';
  perPool: PoolRisk[];
  version: string;
}

function pickDecoder(protocol: string): SwapDecoder | undefined {
  return DECODERS.find(d => d.name === protocol);
}

async function scoreHop(hop: PoolHop, chainId: number, ctx: SkillContext): Promise<PoolRisk> {
  const decoder = pickDecoder(hop.protocol);
  if (!decoder) {
    return {
      protocol: hop.protocol,
      poolAddress: hop.address,
      riskBps: 5000,
      reasons: [`no decoder registered for protocol '${hop.protocol}' — treating as unknown`],
      components: { tvlDriftBps: null, spreadBps: null, inactiveLiquidity: null, oracleHealthBps: null },
    };
  }
  if (!decoder.supports(chainId)) {
    return {
      protocol: decoder.name,
      poolAddress: hop.address,
      riskBps: 5000,
      reasons: [`decoder '${decoder.name}' not deployed on chainId ${chainId}`],
      components: { tvlDriftBps: null, spreadBps: null, inactiveLiquidity: null, oracleHealthBps: null },
    };
  }
  return decoder.scorePool(hop.address, chainId, ctx);
}

async function score(req: ScoreRequest, ctx: SkillContext): Promise<ScoreResponse> {
  const chainId = Number(ctx.env.MEGAETH_CHAIN_ID ?? 6343);
  ctx.logger.info('aggregator.score', { hops: req.hops.length, chainId });

  const perPool = await Promise.all(req.hops.map(h => scoreHop(h, chainId, ctx)));
  const routeRiskBps = perPool.reduce((acc, p) => Math.max(acc, p.riskBps), 0);
  const recommendation = routeRiskBps >= 8500 ? 'BLOCK' : routeRiskBps >= 5000 ? 'WARN' : 'ALLOW';

  return { routeRiskBps, recommendation, perPool, version: 'v0.2-kumbaya' };
}

const skill: Skill = {
  manifest: {
    name: 'mega-aggregator',
    description: 'Aggregator sidecar — scores DEX routes by live pool risk (TVL drift, oracle health, liquidity). Decoders: kumbaya',
    chain: { id: 6343, name: 'MegaETH-testnet', rpc: 'https://carrot.megaeth.com/rpc' },
    adapters: { signer: 'env', chain: 'evm-realtime' },
    streaming: false,
    handlers: ['score'],
  },
  handlers: {
    score: (req, ctx) => score(req as ScoreRequest, ctx),
  },
};

export default skill;
