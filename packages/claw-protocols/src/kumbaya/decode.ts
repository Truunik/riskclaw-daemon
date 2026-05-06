import {
  decodeFunctionData,
  encodeAbiParameters,
  getCreate2Address,
  keccak256,
  type Hex,
} from 'viem';
import { KUMBAYA_ADDRESSES, KUMBAYA_POOL_INIT_CODE_HASH } from './addresses.ts';
import { KUMBAYA_SWAP_ROUTER_ABI } from './router-abi.ts';

export interface DecodedSwap {
  kind: 'exactInputSingle' | 'exactOutputSingle';
  tokenIn: string;
  tokenOut: string;
  fee: number;
  recipient: string;
  amountIn?: bigint;
  amountOut?: bigint;
  amountOutMinimum?: bigint;
  amountInMaximum?: bigint;
  sqrtPriceLimitX96: bigint;
  poolAddress: string;
}

export function computeKumbayaPoolAddress(
  factory: string,
  tokenA: string,
  tokenB: string,
  fee: number,
): string {
  const [t0, t1] = tokenA.toLowerCase() < tokenB.toLowerCase()
    ? [tokenA, tokenB]
    : [tokenB, tokenA];
  const salt = keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }],
      [t0 as Hex, t1 as Hex, fee],
    ),
  );
  return getCreate2Address({
    from: factory as Hex,
    salt,
    bytecodeHash: KUMBAYA_POOL_INIT_CODE_HASH as Hex,
  });
}

export function decodeKumbayaSwap(data: string, chainId: number): DecodedSwap | null {
  const addr = KUMBAYA_ADDRESSES[chainId];
  if (!addr) return null;

  let decoded: ReturnType<typeof decodeFunctionData>;
  try {
    decoded = decodeFunctionData({ abi: KUMBAYA_SWAP_ROUTER_ABI, data: data as Hex });
  } catch {
    return null;
  }

  if (decoded.functionName === 'exactInputSingle') {
    const args = decoded.args as readonly [{
      tokenIn: string;
      tokenOut: string;
      fee: number;
      recipient: string;
      amountIn: bigint;
      amountOutMinimum: bigint;
      sqrtPriceLimitX96: bigint;
    }];
    const p = args[0];
    return {
      kind: 'exactInputSingle',
      tokenIn: p.tokenIn,
      tokenOut: p.tokenOut,
      fee: p.fee,
      recipient: p.recipient,
      amountIn: p.amountIn,
      amountOutMinimum: p.amountOutMinimum,
      sqrtPriceLimitX96: p.sqrtPriceLimitX96,
      poolAddress: computeKumbayaPoolAddress(addr.factory, p.tokenIn, p.tokenOut, p.fee),
    };
  }

  if (decoded.functionName === 'exactOutputSingle') {
    const args = decoded.args as readonly [{
      tokenIn: string;
      tokenOut: string;
      fee: number;
      recipient: string;
      amountOut: bigint;
      amountInMaximum: bigint;
      sqrtPriceLimitX96: bigint;
    }];
    const p = args[0];
    return {
      kind: 'exactOutputSingle',
      tokenIn: p.tokenIn,
      tokenOut: p.tokenOut,
      fee: p.fee,
      recipient: p.recipient,
      amountOut: p.amountOut,
      amountInMaximum: p.amountInMaximum,
      sqrtPriceLimitX96: p.sqrtPriceLimitX96,
      poolAddress: computeKumbayaPoolAddress(addr.factory, p.tokenIn, p.tokenOut, p.fee),
    };
  }

  // exactInput / exactOutput multi-hop: TODO — path is bytes-encoded (token, fee, token, fee, ...)
  return null;
}
