import type { ChainEvent, Skill, SkillContext } from '@claw/core';

interface VaultConfig {
  address: string;
  positionId: string;
  riskSlots: string[];
  exitCalldata: string;
  thresholds: {
    redScoreBps: number;
    minHealthFactorBps: number;
  };
}

function loadVaults(env: Record<string, string | undefined>): VaultConfig[] {
  if (!env.VAULT_CONFIG) return [];
  return JSON.parse(env.VAULT_CONFIG) as VaultConfig[];
}

async function evaluate(vault: VaultConfig, ctx: SkillContext): Promise<{ red: boolean; reasons: string[]; scoreBps: number }> {
  // Deterministic fast-path: read raw slot values, compute health factor.
  // TODO: per-protocol decoders. For now stub.
  const reasons: string[] = [];
  let scoreBps = 0;

  // Slow-path enrichment via TEE compute, only when fast-path is borderline.
  if (ctx.compute && scoreBps >= 4000 && scoreBps < vault.thresholds.redScoreBps) {
    const analysis = await ctx.compute.analyze({
      subjectId: `${vault.address}:${vault.positionId}`,
      metrics: { scoreBps, slots: vault.riskSlots },
      prompt: 'should this user position be exited now?',
    });
    scoreBps = Math.max(scoreBps, analysis.riskScoreBps);
    reasons.push(...analysis.reasoning);
  }

  return { red: scoreBps >= vault.thresholds.redScoreBps, reasons, scoreBps };
}

async function onStateChange(vault: VaultConfig, event: ChainEvent, ctx: SkillContext): Promise<void> {
  ctx.logger.info('state change', { vault: vault.address, block: event.blockNumber });
  const verdict = await evaluate(vault, ctx);
  if (!verdict.red) return;

  ctx.logger.warn('RED — exiting position', { vault: vault.address, score: verdict.scoreBps, reasons: verdict.reasons });
  const tx = await ctx.signer.send({ to: vault.address, data: vault.exitCalldata });
  ctx.logger.info('exit submitted', { hash: tx.hash });

  if (ctx.storage) {
    const decision = JSON.stringify({ vault: vault.address, verdict, txHash: tx.hash, ts: Date.now() });
    const root = await ctx.storage.put(new TextEncoder().encode(decision), 'decision');
    ctx.logger.info('decision logged', { root });
  }
}

async function start(ctx: SkillContext): Promise<void> {
  const vaults = loadVaults(ctx.env);
  ctx.logger.info('mega-vault-exiter starting', { vaults: vaults.length, signer: ctx.signer.address() });

  if (vaults.length === 0) {
    ctx.logger.warn('no vaults configured — set VAULT_CONFIG env');
    return;
  }
  if (!ctx.chain.subscribe) {
    ctx.logger.error('chain adapter does not support subscribe — need MegaETH realtime adapter');
    return;
  }

  for (const vault of vaults) {
    await ctx.chain.subscribe(
      { kind: 'stateChanges', address: vault.address, slots: vault.riskSlots },
      event => { void onStateChange(vault, event, ctx); },
    );
    ctx.logger.info('subscribed', { vault: vault.address, slots: vault.riskSlots.length });
  }
}

const skill: Skill = {
  manifest: {
    name: 'mega-vault-exiter',
    description: 'Bounded-delegation auto-exiter: stateChanges subscription on vaults, signs withdraw on red signal',
    chain: { id: 6343, name: 'MegaETH-testnet', rpc: 'https://carrot.megaeth.com/rpc', ws: 'wss://carrot.megaeth.com/ws' },
    adapters: { compute: 'tee', storage: 'content-addressed', signer: 'delegated', chain: 'evm-realtime' },
    streaming: true,
  },
  start,
};

export default skill;
