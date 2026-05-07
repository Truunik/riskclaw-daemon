export interface PrismAddresses {
  factory: string;
  positionManager: string;
  universalRouter: string;
  weth: string;
  // SwapRouter02 / QuoterV2 / SelectiveTaxRouter: still pending. Prism's docs name
  // them but don't publish addresses. UniversalRouter was recovered on-chain by
  // tracing tx.to from Swap events on Prism-only pools and verifying the bytecode
  // contains the Prism factory address as an immutable.
}

// Source:
//   factory + positionManager — https://prismfi.cc/docs/overview
//   universalRouter — discovered on-chain (selector 0x3593564c · execute(bytes,bytes[],uint256);
//                     bytecode references the Prism factory)
//   Init code hash matches canonical UniV3 (verified by deriving pool 0x1B6C…70E1 byte-perfect).
//   Testnet (6343) does not host Prism at the same addresses.
export const PRISM_ADDRESSES: Record<number, PrismAddresses> = {
  4326: {
    factory: '0x1adb8f973373505bb206e0e5d87af8fb1f5514ef',
    positionManager: '0xcb91c75a6b29700756d4411495be696c4e9a576e',
    universalRouter: '0x955d56F6391a496231509134e0d2Beadf82a223f',
    weth: '0x4200000000000000000000000000000000000006',
  },
};

export function prismContracts(chainId: number): Set<string> {
  const a = PRISM_ADDRESSES[chainId];
  if (!a) return new Set();
  return new Set([a.factory, a.positionManager, a.universalRouter].map(x => x.toLowerCase()));
}

// Canonical Uniswap V3 pool init code hash — verified against Prism mainnet.
export const PRISM_POOL_INIT_CODE_HASH =
  '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54';
