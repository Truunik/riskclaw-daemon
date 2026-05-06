import type { Skill, SkillContext } from '@claw/core';

interface PoolSnapshot {
  poolId: string;
  tvlDelta24hBps: number;
  priceImpactBps: number;
  lastSwapAmountBps: number;
  isDrain: boolean;
}

async function runOnce(snapshot: PoolSnapshot, ctx: SkillContext) {
  if (!ctx.compute || !ctx.storage) {
    ctx.logger.error('0g-uniswap-hook requires compute + storage adapters');
    return;
  }

  const metricsBlob = new TextEncoder().encode(JSON.stringify(snapshot));
  const metricsRoot = await ctx.storage.put(metricsBlob, 'metrics');
  ctx.logger.info('observer', { metricsRoot });

  const analysis = await ctx.compute.analyze({
    subjectId: snapshot.poolId,
    metrics: { ...snapshot },
    prompt: 'evaluate v4 pool risk; output a riskScoreBps and reasons',
  });
  const memoRoot = await ctx.storage.put(analysis.rawMemo, 'memo');
  ctx.logger.info('analyst', {
    memoRoot,
    riskScoreBps: analysis.riskScoreBps,
    provider: analysis.provider,
    responseId: analysis.responseId,
  });

  const decision = decide(analysis.riskScoreBps);
  ctx.logger.info('guardian', { decision, score: analysis.riskScoreBps });

  if (decision.action === 'NO_OP') return;

  const registry = ctx.env.RISK_POLICY_REGISTRY;
  if (!registry) {
    ctx.logger.warn('RISK_POLICY_REGISTRY not set — dry-run');
    return;
  }
  const calldata = encodeUpdatePolicy(snapshot.poolId, analysis.riskScoreBps, decision.dynamicFee, memoRoot, metricsRoot);
  const tx = await ctx.signer.send({ to: registry, data: calldata });
  ctx.logger.info('executor', { tx: tx.hash });
}

function decide(scoreBps: number): { action: 'ALLOW' | 'PENALTY_FEE' | 'BLOCK' | 'NO_OP'; dynamicFee: number } {
  if (scoreBps >= 8500) return { action: 'BLOCK', dynamicFee: 0 };
  if (scoreBps >= 5000) return { action: 'PENALTY_FEE', dynamicFee: 100_000 };
  return { action: 'ALLOW', dynamicFee: 3_000 };
}

function encodeUpdatePolicy(
  _poolId: string,
  _scoreBps: number,
  _dynamicFee: number,
  _memoRoot: string,
  _metricsRoot: string,
): string {
  // TODO: real ABI-encoded updatePolicy(...) calldata once viem is wired.
  return '0x';
}

async function start(ctx: SkillContext): Promise<void> {
  ctx.logger.info('0g-uniswap-hook starting (kernel port of RiskClaw hackathon)');
  const demoSnapshot: PoolSnapshot = {
    poolId: '0x' + '11'.repeat(32),
    tvlDelta24hBps: 7400,
    priceImpactBps: 620,
    lastSwapAmountBps: 1800,
    isDrain: true,
  };
  await runOnce(demoSnapshot, ctx);
}

const skill: Skill = {
  manifest: {
    name: '0g-uniswap-hook',
    description: 'v4-style hook + agent swarm enforcing per-pool risk policy on 0G (port of the hackathon thesis)',
    chain: { id: 16602, name: '0G-Galileo', rpc: 'https://evmrpc-testnet.0g.ai' },
    adapters: { compute: 'tee', storage: 'content-addressed', signer: 'env', chain: 'evm' },
    streaming: true,
  },
  start,
};

export default skill;
