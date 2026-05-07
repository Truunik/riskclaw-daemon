import { keccak256, parseAbi, type Hex } from 'viem';
import type { ChainAdapter } from '@claw/core';

/**
 * Curated bytecode-keccak hashes flagged as known mass-deployment scam templates.
 *
 * Adding to this set: identify ≥3 tokens that share *all* of —
 *   (a) identical bytecode keccak,
 *   (b) suspicious totalSupply (e.g., exact 1e27),
 *   (c) vanity-style address suffixes,
 * — and add the shared hash here with the source audit reference.
 */
const SCAM_TEMPLATE_HASHES: Record<string, string> = {
  // 8384-byte template, 6 known *b1d-suffix siblings on MegaETH 4326 (BOBO,
  // MMMA, metox, rrx, two "test"s) — all 1e27 totalSupply, all identical code.
  // Source: riskclaw audit · Prism · 2026-05-07 · finding P3.
  '0xd606605f35320f115cf15a6a6e62780133bd39ebc31b3dc42c35d2bb8c4f9c28':
    'mass-deployment scam template — 6+ siblings on MegaETH 4326 (BOBO/MMMA/metox/rrx/test) share this exact bytecode',
};

const SUSPICIOUS_ROUND_SUPPLIES_18 = new Set([
  // 1e27 = 1B × 10^18 — classic memecoin supply
  '1000000000000000000000000000',
  // 1e28 = 10B × 10^18
  '10000000000000000000000000000',
  // 1e29 = 100B × 10^18
  '100000000000000000000000000000',
]);

const ERC20_TOTAL = parseAbi(['function totalSupply() view returns (uint256)']);
const ERC20_DECIMALS = parseAbi(['function decimals() view returns (uint8)']);

interface CachedToken {
  codeHash: string | null;
  totalSupply: bigint | null;
  decimals: number | null;
  hasMint: boolean;
  hasPause: boolean;
  bytecodeBytes: number;
}

// Function selectors we look up in the deployed bytecode. A selector appearing in
// runtime code does not prove the function is reachable, but for these well-known
// signatures it's a strong signal that the function is part of the contract's API.
const SELECTOR_MINT = '40c10f19';        // mint(address,uint256)
const SELECTOR_PAUSE = '8456cb59';       // pause()
const cache = new Map<string, CachedToken>();

export interface TokenPatternRisk {
  riskBps: number;
  reasons: string[];
}

/**
 * Returns true if the address ends with 3+ identical hex chars (e.g. …cccc, …0000, …AAAA9).
 * Cheap pre-filter; not a risk by itself, only paired with another scam-shape signal.
 */
function hasVanitySuffix(address: string): boolean {
  const tail = address.toLowerCase().slice(-4);
  if (tail.length !== 4) return false;
  return (tail[0] === tail[1] && tail[1] === tail[2]) ||
         (tail[1] === tail[2] && tail[2] === tail[3]);
}

async function loadToken(address: string, chain: ChainAdapter): Promise<CachedToken> {
  const key = address.toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;

  let codeHash: string | null = null;
  let hasMint = false;
  let hasPause = false;
  let bytecodeBytes = 0;
  try {
    const code = await chain.getCode(address);
    if (code) {
      const lower = code.toLowerCase();
      codeHash = keccak256(code as Hex);
      hasMint = lower.includes(SELECTOR_MINT);
      hasPause = lower.includes(SELECTOR_PAUSE);
      bytecodeBytes = (code.length - 2) / 2; // strip 0x prefix, 2 hex chars per byte
    }
  } catch { /* unsupported by adapter — skip */ }

  let totalSupply: bigint | null = null;
  try {
    totalSupply = await chain.readContract<bigint>({
      address, abi: ERC20_TOTAL, functionName: 'totalSupply',
    });
  } catch { /* not an ERC20 or call failed */ }

  let decimals: number | null = null;
  try {
    decimals = await chain.readContract<number>({
      address, abi: ERC20_DECIMALS, functionName: 'decimals',
    });
  } catch { /* skip */ }

  const entry: CachedToken = { codeHash, totalSupply, decimals, hasMint, hasPause, bytecodeBytes };
  cache.set(key, entry);
  return entry;
}

/**
 * Score a single token for known scam patterns. Multiple signals stack, capped at 10000 bps.
 *
 *   - bytecode keccak matches a curated mass-deployment scam template → +6000 bps
 *   - vanity address suffix + suspicious round 1e27/1e28/1e29 supply  → +3000 bps
 *   - mint(address,uint256) selector in bytecode                      → +2000 bps (supply inflatable)
 *   - pause() selector in bytecode                                    → +1500 bps (transfers freezable)
 */
export async function tokenPatternRisk(
  tokenAddress: string,
  chain: ChainAdapter,
): Promise<TokenPatternRisk> {
  const t = await loadToken(tokenAddress, chain);
  const reasons: string[] = [];
  let riskBps = 0;

  if (t.codeHash && SCAM_TEMPLATE_HASHES[t.codeHash.toLowerCase()]) {
    riskBps += 6000;
    reasons.push(
      `token ${tokenAddress.slice(0, 10)}…: bytecode matches a known mass-deployment scam template (${SCAM_TEMPLATE_HASHES[t.codeHash.toLowerCase()]})`,
    );
  } else if (
    t.totalSupply !== null &&
    SUSPICIOUS_ROUND_SUPPLIES_18.has(t.totalSupply.toString()) &&
    hasVanitySuffix(tokenAddress)
  ) {
    riskBps += 3000;
    reasons.push(
      `token ${tokenAddress.slice(0, 10)}…: vanity-suffix address with suspiciously round 1e${t.totalSupply.toString().length - 1} supply (memecoin/scam shape)`,
    );
  }

  if (t.hasMint) {
    riskBps += 2000;
    reasons.push(`token ${tokenAddress.slice(0, 10)}…: mint(address,uint256) selector present — supply may be inflated by an admin`);
  }
  if (t.hasPause) {
    riskBps += 1500;
    reasons.push(`token ${tokenAddress.slice(0, 10)}…: pause() selector present — admin can freeze transfers`);
  }

  return { riskBps: Math.min(10_000, riskBps), reasons };
}

/** Read ERC20 decimals using the same cache as the pattern scorer (free after first call). */
export async function getTokenDecimals(
  tokenAddress: string,
  chain: ChainAdapter,
): Promise<number | null> {
  return (await loadToken(tokenAddress, chain)).decimals;
}

/** Score both tokens in a UniV3 pool; returns the higher signal (worst-of). */
export async function poolTokenPatternRisk(
  token0: string,
  token1: string,
  chain: ChainAdapter,
): Promise<TokenPatternRisk> {
  const [r0, r1] = await Promise.all([
    tokenPatternRisk(token0, chain),
    tokenPatternRisk(token1, chain),
  ]);
  if (r0.riskBps >= r1.riskBps) return { riskBps: r0.riskBps, reasons: [...r0.reasons, ...r1.reasons] };
  return { riskBps: r1.riskBps, reasons: [...r1.reasons, ...r0.reasons] };
}
