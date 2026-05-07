import { createPublicClient, http, parseAbi, parseAbiItem, getAddress, type Hex } from 'viem';
import type { SkillContext } from '@claw/core';
import {
  KumbayaDecoder,
  PrismDecoder,
  KUMBAYA_ADDRESSES,
  PRISM_ADDRESSES,
  type SwapDecoder,
} from '@claw/protocols';
import { EvmRealtimeChain, MockSigner } from '@claw/adapters';

export type ProtocolName = 'kumbaya' | 'prism';

export interface AuditOptions {
  protocol: ProtocolName;
  chainId: number;
  /** Override RPC URL; defaults to MegaETH public RPC for the chain. */
  rpcUrl?: string;
  /** Cap pool walkback to keep audits bounded; default scans full chain history. */
  maxLookbackBlocks?: bigint;
}

export interface ProtocolAudit {
  protocol: string;
  chainId: number;
  scannedAt: string;
  blockHeight: number;
  setup: {
    factory: string;
    factoryOwner: string | null;
    factoryOwnerKind: 'EOA' | 'contract' | 'unknown';
    positionManager: string | null;
    universalRouter: string | null;
    feeTiers: { fee: number; tickSpacing: number; enabled: boolean }[];
  };
  pools: {
    total: number;
    feeDistribution: { fee: number; count: number }[];
    averageRiskBps: number;
    healthyCount: number;
    deadCount: number;
    perPool: PoolEntry[];
  };
  tokens: {
    unique: number;
    survey: TokenEntry[];
  };
  findings: Finding[];
}

export interface PoolEntry {
  pool: string;
  fee: number;
  tickSpacing: number;
  riskBps: number;
  reasons: string[];
  liquidity: string;
  cardinality: number;
  blockCreated: number;
}

export interface TokenEntry {
  address: string;
  symbol: string;
  decimals: number | null;
  totalSupply: string | null;
  bytecodeBytes: number;
}

export interface Finding {
  severity: 'high' | 'medium' | 'low' | 'info';
  id: string;
  title: string;
  detail: string;
}

const PROTOCOLS: Record<ProtocolName, {
  decoder: SwapDecoder;
  factoryByChain: (chainId: number) => string | null;
  posMgrByChain: (chainId: number) => string | null;
  routerByChain: (chainId: number) => string | null;
}> = {
  kumbaya: {
    decoder: KumbayaDecoder,
    factoryByChain: (c) => KUMBAYA_ADDRESSES[c]?.factory ?? null,
    posMgrByChain: (c) => KUMBAYA_ADDRESSES[c]?.positionManager ?? null,
    routerByChain: (c) => KUMBAYA_ADDRESSES[c]?.universalRouter ?? null,
  },
  prism: {
    decoder: PrismDecoder,
    factoryByChain: (c) => PRISM_ADDRESSES[c]?.factory ?? null,
    posMgrByChain: (c) => PRISM_ADDRESSES[c]?.positionManager ?? null,
    routerByChain: (c) => PRISM_ADDRESSES[c]?.universalRouter ?? null,
  },
};

const POOL_CREATED = parseAbiItem(
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
);
const FACTORY_ABI = parseAbi([
  'function owner() view returns (address)',
  'function feeAmountTickSpacing(uint24 fee) view returns (int24)',
]);
const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
]);
const POOL_READ_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
]);

function defaultRpc(chainId: number): string {
  if (chainId === 4326) return 'https://mainnet.megaeth.com/rpc';
  if (chainId === 6343) return 'https://carrot.megaeth.com/rpc';
  throw new Error(`no default RPC for chainId ${chainId}`);
}

export async function auditProtocol(opts: AuditOptions): Promise<ProtocolAudit> {
  const desc = PROTOCOLS[opts.protocol];
  if (!desc) throw new Error(`unknown protocol: ${opts.protocol}`);
  const factory = desc.factoryByChain(opts.chainId);
  if (!factory) throw new Error(`${opts.protocol} not deployed on chainId ${opts.chainId}`);

  const rpcUrl = opts.rpcUrl ?? defaultRpc(opts.chainId);
  const client = createPublicClient({ transport: http(rpcUrl) });

  // SkillContext for decoder.scorePool — wraps the same RPC.
  const chain = new EvmRealtimeChain({ rpcUrl, chainId: opts.chainId });
  const ctx: SkillContext = {
    chain,
    signer: new MockSigner(),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    env: { MEGAETH_CHAIN_ID: String(opts.chainId), MEGAETH_RPC_URL: rpcUrl },
  };

  // 1. Protocol setup.
  let factoryOwner: string | null = null;
  let factoryOwnerKind: 'EOA' | 'contract' | 'unknown' = 'unknown';
  try {
    factoryOwner = (await client.readContract({
      address: factory as Hex, abi: FACTORY_ABI, functionName: 'owner',
    })) as string;
    const code = await client.getCode({ address: factoryOwner as Hex });
    factoryOwnerKind = code && code !== '0x' ? 'contract' : 'EOA';
  } catch { /* factory may not expose owner() */ }

  const feeTiers: { fee: number; tickSpacing: number; enabled: boolean }[] = [];
  for (const fee of [100, 500, 3000, 10000]) {
    try {
      const ts = (await client.readContract({
        address: factory as Hex, abi: FACTORY_ABI, functionName: 'feeAmountTickSpacing', args: [fee],
      })) as number;
      feeTiers.push({ fee, tickSpacing: ts, enabled: ts !== 0 });
    } catch {
      feeTiers.push({ fee, tickSpacing: 0, enabled: false });
    }
  }

  // 2. Pool inventory — walk PoolCreated events back from latest.
  const latest = await client.getBlockNumber();
  const oldest = opts.maxLookbackBlocks !== undefined && latest > opts.maxLookbackBlocks
    ? latest - opts.maxLookbackBlocks
    : 0n;
  const poolCreations: { pool: string; t0: string; t1: string; fee: number; ts: number; block: number }[] = [];
  for (let end = latest; end > oldest; ) {
    const start = end > 50_000n ? end - 50_000n : oldest;
    try {
      const logs = await client.getLogs({ address: factory as Hex, event: POOL_CREATED, fromBlock: start, toBlock: end });
      for (const l of logs) {
        poolCreations.push({
          pool: getAddress(l.args.pool!),
          t0: getAddress(l.args.token0!),
          t1: getAddress(l.args.token1!),
          fee: Number(l.args.fee!),
          ts: Number(l.args.tickSpacing!),
          block: Number(l.blockNumber!),
        });
      }
    } catch { /* skip chunks that error */ }
    if (start <= oldest) break;
    end = start;
  }
  poolCreations.sort((a, b) => a.block - b.block);

  // 3. Per-pool risk + state — parallelized in batches of 6 to stay under public-RPC rate limits.
  const tokenSet = new Set<string>();
  let totalScore = 0;
  let deadCount = 0;
  let healthyCount = 0;
  for (const p of poolCreations) { tokenSet.add(p.t0); tokenSet.add(p.t1); }

  async function scoreOne(p: typeof poolCreations[number]): Promise<PoolEntry> {
    try {
      const [r, slot0, lq] = await Promise.all([
        desc.decoder.scorePool(p.pool, opts.chainId, ctx),
        client.readContract({ address: p.pool as Hex, abi: POOL_READ_ABI, functionName: 'slot0' }) as Promise<readonly [bigint, number, number, number, number, number, boolean]>,
        client.readContract({ address: p.pool as Hex, abi: POOL_READ_ABI, functionName: 'liquidity' }) as Promise<bigint>,
      ]);
      totalScore += r.riskBps;
      if (lq === 0n) deadCount++;
      else if (slot0[3] >= 10 && r.riskBps === 0) healthyCount++;
      return {
        pool: p.pool, fee: p.fee, tickSpacing: p.ts,
        riskBps: r.riskBps, reasons: r.reasons,
        liquidity: lq.toString(), cardinality: slot0[3], blockCreated: p.block,
      };
    } catch (err) {
      return {
        pool: p.pool, fee: p.fee, tickSpacing: p.ts,
        riskBps: -1, reasons: [`SCORE FAILED: ${(err as Error).message.split('\n')[0]}`],
        liquidity: '0', cardinality: 0, blockCreated: p.block,
      };
    }
  }

  const perPool: PoolEntry[] = [];
  const BATCH = 6;
  for (let i = 0; i < poolCreations.length; i += BATCH) {
    const batch = poolCreations.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(scoreOne));
    perPool.push(...results);
  }
  perPool.sort((a, b) => b.riskBps - a.riskBps);

  // 4. Token survey — same batching strategy.
  async function surveyOne(t: string): Promise<TokenEntry> {
    let symbol = '?', decimals: number | null = null, totalSupply: string | null = null, bytecodeBytes = 0;
    try {
      const [code, sym, dec, ts] = await Promise.all([
        client.getCode({ address: t as Hex }),
        client.readContract({ address: t as Hex, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => '?'),
        client.readContract({ address: t as Hex, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => null),
        client.readContract({ address: t as Hex, abi: ERC20_ABI, functionName: 'totalSupply' }).catch(() => null),
      ]);
      bytecodeBytes = code ? (code.length - 2) / 2 : 0;
      symbol = sym as string;
      decimals = dec === null ? null : (dec as number);
      totalSupply = ts === null ? null : (ts as bigint).toString();
    } catch { /* skip */ }
    return { address: t, symbol, decimals, totalSupply, bytecodeBytes };
  }

  const survey: TokenEntry[] = [];
  const tokens = [...tokenSet];
  for (let i = 0; i < tokens.length; i += BATCH) {
    const batch = tokens.slice(i, i + BATCH);
    survey.push(...await Promise.all(batch.map(surveyOne)));
  }

  // 5. Compose findings.
  const total = perPool.length;
  const feeDist = new Map<number, number>();
  for (const p of perPool) feeDist.set(p.fee, (feeDist.get(p.fee) ?? 0) + 1);

  const findings: Finding[] = [];
  if (factoryOwnerKind === 'EOA' && factoryOwner) {
    findings.push({
      severity: 'high', id: 'P1',
      title: 'Factory owner is an EOA, not a multisig',
      detail: `factory.owner() = ${factoryOwner} has no contract code. A single private key controls fee-tier governance (enableFeeAmount + setOwner). If compromised, attacker can add malicious fee tiers permanently.`,
    });
  }
  if (total > 0 && deadCount / total >= 0.3) {
    findings.push({
      severity: 'high', id: 'P2',
      title: `${deadCount}/${total} pools (${Math.round(deadCount/total*100)}%) are dead-on-arrival`,
      detail: 'Listed pools with zero liquidity are visual decoys. Attackers can seed 1 wei at a chosen price to trap users who confuse pool existence for legitimacy.',
    });
  }
  const scamMatches = perPool.filter(p => p.reasons.some(r => r.includes('mass-deployment scam template')));
  if (scamMatches.length > 0) {
    findings.push({
      severity: 'high', id: 'P3',
      title: `${scamMatches.length} pool(s) pair a known scam-template token`,
      detail: `Pools whose tokens match the curated scam-bytecode list: ${scamMatches.slice(0, 5).map(p => p.pool).join(', ')}${scamMatches.length > 5 ? ', …' : ''}`,
    });
  }
  const cardOne = perPool.filter(p => p.cardinality === 1).length;
  if (total > 0 && cardOne / total >= 0.5) {
    findings.push({
      severity: 'medium', id: 'P4',
      title: `${cardOne}/${total} pools (${Math.round(cardOne/total*100)}%) have oracle cardinality = 1`,
      detail: 'TWAP is unavailable; downstream protocols using these as price oracles are vulnerable to single-block manipulation.',
    });
  }
  const mintable = perPool.filter(p => p.reasons.some(r => r.includes('mint(address,uint256) selector'))).length;
  if (mintable > 0) {
    findings.push({
      severity: 'medium', id: 'P5',
      title: `${mintable} pool(s) pair a token with mint() selector`,
      detail: 'Token supply can be inflated by an admin; users who hold the token are exposed to dilution risk.',
    });
  }
  if (healthyCount > 0) {
    findings.push({
      severity: 'info', id: 'P9',
      title: `${healthyCount} pool(s) are usable for downstream oracles`,
      detail: 'Cardinality ≥ 10 + clean risk score. These are the only pools fit-for-purpose for lending/derivatives that need a manipulation-resistant TWAP.',
    });
  }

  return {
    protocol: opts.protocol,
    chainId: opts.chainId,
    scannedAt: new Date().toISOString(),
    blockHeight: Number(latest),
    setup: {
      factory,
      factoryOwner,
      factoryOwnerKind,
      positionManager: desc.posMgrByChain(opts.chainId),
      universalRouter: desc.routerByChain(opts.chainId),
      feeTiers,
    },
    pools: {
      total,
      feeDistribution: [...feeDist.entries()].sort().map(([fee, count]) => ({ fee, count })),
      averageRiskBps: total > 0 ? Math.round(totalScore / total) : 0,
      healthyCount,
      deadCount,
      perPool,
    },
    tokens: {
      unique: tokenSet.size,
      survey,
    },
    findings,
  };
}

/** Pretty-text formatter for CLI output. */
export function formatAuditText(a: ProtocolAudit): string {
  const lines: string[] = [];
  lines.push(`# riskclaw audit · ${a.protocol} · chainId ${a.chainId} · ${a.scannedAt}`);
  lines.push(`# block height ${a.blockHeight}`);
  lines.push('');
  lines.push('## protocol setup');
  lines.push(`  factory          ${a.setup.factory}`);
  lines.push(`  positionManager  ${a.setup.positionManager ?? '(unknown)'}`);
  lines.push(`  universalRouter  ${a.setup.universalRouter ?? '(unknown)'}`);
  lines.push(`  factory.owner    ${a.setup.factoryOwner ?? '(unavailable)'} ${a.setup.factoryOwnerKind === 'EOA' ? '⚠ EOA' : a.setup.factoryOwnerKind === 'contract' ? '✓ contract' : ''}`);
  lines.push(`  fee tiers        ${a.setup.feeTiers.map(t => `${t.fee}${t.enabled ? '' : '✗'}`).join(' ')}`);
  lines.push('');
  lines.push(`## pools · ${a.pools.total} total · avg ${a.pools.averageRiskBps}bps · ${a.pools.deadCount} dead · ${a.pools.healthyCount} healthy`);
  lines.push(`  fee distribution: ${a.pools.feeDistribution.map(d => `${d.fee}:${d.count}`).join(' ')}`);
  lines.push('');
  lines.push('## top 10 risky pools');
  for (const p of a.pools.perPool.slice(0, 10)) {
    lines.push(`  ${p.pool} fee=${p.fee} score=${p.riskBps}bps liq=${p.liquidity} card=${p.cardinality}`);
    for (const r of p.reasons) lines.push(`     ${r}`);
  }
  lines.push('');
  lines.push(`## tokens · ${a.tokens.unique} unique`);
  for (const t of a.tokens.survey.slice(0, 20)) {
    lines.push(`  ${t.address}  sym=${t.symbol} dec=${t.decimals ?? '?'} code=${t.bytecodeBytes}b totalSupply=${t.totalSupply ?? '?'}`);
  }
  if (a.tokens.survey.length > 20) lines.push(`  … and ${a.tokens.survey.length - 20} more`);
  lines.push('');
  lines.push('## findings');
  for (const f of a.findings) {
    lines.push(`[${f.severity.toUpperCase()}] ${f.id} — ${f.title}`);
    lines.push(`         ${f.detail}`);
  }
  return lines.join('\n');
}
