export * from './types.ts';
export { ERC20_ABI } from './erc20.ts';
export {
  KumbayaDecoder,
  computeKumbayaPoolAddress,
  decodeKumbayaSwap,
  buildExactInputSingleCalldata,
  type DecodedSwap,
  type BuildSwapCalldataInput,
  type BuiltSwapCalldata,
} from './kumbaya/index.ts';
export {
  KUMBAYA_ADDRESSES,
  kumbayaContracts,
  KUMBAYA_POOL_INIT_CODE_HASH,
} from './kumbaya/addresses.ts';
export { KUMBAYA_SWAP_ROUTER_ABI } from './kumbaya/router-abi.ts';
export { PrismDecoder, computePrismPoolAddress } from './prism/index.ts';
export { PRISM_ADDRESSES, PRISM_POOL_INIT_CODE_HASH, prismContracts } from './prism/addresses.ts';

// No SwapRouter02 ABI for Prism yet — Prism users transact via UniversalRouter, whose
// calldata uses a command-stream encoding that neither Kumbaya nor Prism currently parse.
// `decodePrismSwap` is exported as null-returning so mega-preflight gets the expected
// "router recognized but calldata undecoded" partial result.
export const decodePrismSwap = (): null => null;

export {
  tokenPatternRisk,
  poolTokenPatternRisk,
  getTokenDecimals,
  type TokenPatternRisk,
} from './token-patterns.ts';

export {
  stablePairDePegRisk,
  readTvlDriftAt,
  type DePegRisk,
  type TvlDrift,
} from './pool-patterns.ts';

export {
  decodeUniversalRouter,
  decodeUniV3Path,
  extractV3Swaps,
  Command,
  type DecodedV3Swap,
  type DecodedCommand,
  type DecodedHop,
  type UniversalRouterCalldata,
} from './universal-router.ts';
