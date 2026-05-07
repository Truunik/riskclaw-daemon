import ogUniswapHook from '@claw/skill-0g-uniswap-hook';
import megaVaultExiter from '@claw/skill-mega-vault-exiter';
import megaPreflight from '@claw/skill-mega-preflight';
import megaAggregator from '@claw/skill-mega-aggregator';
import { SkillRegistry } from './registry.ts';
import { buildContext } from './context.ts';

export const registry = new SkillRegistry();
registry.register(ogUniswapHook);
registry.register(megaVaultExiter);
registry.register(megaPreflight);
registry.register(megaAggregator);

export { buildContext };
export { auditProtocol, formatAuditText, type ProtocolAudit, type AuditOptions } from './audit.ts';

if (import.meta.main) {
  console.log('riskclaw-daemon — skills loaded:');
  for (const s of registry.list()) {
    console.log(`  - ${s.manifest.name} (${s.manifest.chain.name}) — ${s.manifest.description}`);
  }
}
