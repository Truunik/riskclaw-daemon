import {
  decodeAbiParameters,
  decodeFunctionData,
  parseAbi,
  parseAbiParameters,
  type Hex,
} from 'viem';

/**
 * Uniswap UniversalRouter command-stream decoder.
 *
 * Calldata layout: `execute(bytes commands, bytes[] inputs, uint256 deadline)`
 *   - `commands` is a packed byte string; each byte is one command opcode.
 *   - `inputs[i]` is the ABI-encoded args for command `commands[i]`.
 *
 * We only fully decode the swap commands today (V3 only). Other commands are
 * captured as `unknown` so callers can still see the intent without crashing.
 */

export const UNIVERSAL_ROUTER_ABI = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
]);

// Subset of Uniswap commands we recognize. Source: @uniswap/universal-router/Commands.sol
export const Command = {
  V3_SWAP_EXACT_IN: 0x00,
  V3_SWAP_EXACT_OUT: 0x01,
  PERMIT2_TRANSFER_FROM: 0x02,
  PERMIT2_PERMIT_BATCH: 0x03,
  SWEEP: 0x04,
  TRANSFER: 0x05,
  PAY_PORTION: 0x06,
  V2_SWAP_EXACT_IN: 0x08,
  V2_SWAP_EXACT_OUT: 0x09,
  PERMIT2_PERMIT: 0x0a,
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
} as const;

export interface DecodedHop {
  tokenIn: string;
  tokenOut: string;
  fee: number;
}

export interface DecodedV3Swap {
  kind: 'V3_SWAP_EXACT_IN' | 'V3_SWAP_EXACT_OUT';
  recipient: string;
  /** For EXACT_IN: amountIn. For EXACT_OUT: amountOut. */
  amountSpecified: bigint;
  /** For EXACT_IN: amountOutMinimum. For EXACT_OUT: amountInMaximum. */
  amountLimit: bigint;
  hops: DecodedHop[];
  payerIsUser: boolean;
}

export interface UnknownCommand {
  kind: 'unknown';
  opcode: number;
  rawInput: string;
}

export type DecodedCommand = DecodedV3Swap | UnknownCommand;

export interface UniversalRouterCalldata {
  commands: DecodedCommand[];
  deadline: bigint;
}

/**
 * Decode a UniV3 path: `(20-byte token)(3-byte fee)(20-byte token)(3-byte fee)...(20-byte token)`.
 * Returns one entry per hop. A 1-hop swap has 1 entry; an N-hop swap has N entries.
 */
export function decodeUniV3Path(pathHex: string): DecodedHop[] {
  const stripped = pathHex.startsWith('0x') ? pathHex.slice(2) : pathHex;
  const HOP_BYTES = 23; // 20 token + 3 fee
  const TOKEN_BYTES = 20;
  if (stripped.length < (TOKEN_BYTES + HOP_BYTES) * 2) return [];
  if ((stripped.length - TOKEN_BYTES * 2) % (HOP_BYTES * 2) !== 0) return [];

  const hops: DecodedHop[] = [];
  let cursor = 0;
  while (cursor + (HOP_BYTES + TOKEN_BYTES) * 2 <= stripped.length) {
    const tokenIn = '0x' + stripped.slice(cursor, cursor + TOKEN_BYTES * 2);
    const fee = parseInt(stripped.slice(cursor + TOKEN_BYTES * 2, cursor + (TOKEN_BYTES + 3) * 2), 16);
    const tokenOut = '0x' + stripped.slice(cursor + (TOKEN_BYTES + 3) * 2, cursor + (TOKEN_BYTES + 3 + TOKEN_BYTES) * 2);
    hops.push({ tokenIn, tokenOut, fee });
    cursor += HOP_BYTES * 2;
  }
  return hops;
}

const V3_SWAP_INPUT_PARAMS = parseAbiParameters(
  'address recipient, uint256 amountSpecified, uint256 amountLimit, bytes path, bool payerIsUser',
);

function decodeV3Swap(opcode: number, inputBytes: Hex): DecodedV3Swap | UnknownCommand {
  try {
    const [recipient, amountSpecified, amountLimit, path, payerIsUser] = decodeAbiParameters(
      V3_SWAP_INPUT_PARAMS,
      inputBytes,
    ) as [string, bigint, bigint, string, boolean];
    const hops = decodeUniV3Path(path);
    if (hops.length === 0) return { kind: 'unknown', opcode, rawInput: inputBytes };
    return {
      kind: opcode === Command.V3_SWAP_EXACT_IN ? 'V3_SWAP_EXACT_IN' : 'V3_SWAP_EXACT_OUT',
      recipient,
      amountSpecified,
      amountLimit,
      hops,
      payerIsUser,
    };
  } catch {
    return { kind: 'unknown', opcode, rawInput: inputBytes };
  }
}

/**
 * Decode UniversalRouter `execute(...)` calldata. Returns null if the target selector
 * doesn't match or the top-level decode fails (calldata isn't a UniversalRouter call).
 */
export function decodeUniversalRouter(data: string): UniversalRouterCalldata | null {
  if (!data || data.length < 10) return null;
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data: data as Hex });
  } catch {
    return null;
  }
  if (decoded.functionName !== 'execute') return null;

  const [commandsHex, inputs, deadline] = decoded.args as readonly [string, readonly Hex[], bigint];
  const commandBytes = (commandsHex.startsWith('0x') ? commandsHex.slice(2) : commandsHex);
  const numCommands = commandBytes.length / 2;

  if (inputs.length !== numCommands) return null;

  const commands: DecodedCommand[] = [];
  for (let i = 0; i < numCommands; i++) {
    const opcode = parseInt(commandBytes.slice(i * 2, i * 2 + 2), 16);
    const inputBytes = inputs[i]!;
    if (opcode === Command.V3_SWAP_EXACT_IN || opcode === Command.V3_SWAP_EXACT_OUT) {
      commands.push(decodeV3Swap(opcode, inputBytes));
    } else {
      commands.push({ kind: 'unknown', opcode, rawInput: inputBytes });
    }
  }

  return { commands, deadline };
}

/**
 * Convenience: extract just the V3 swap commands from a UniversalRouter calldata.
 * Filters out PERMIT/SWEEP/WRAP plumbing.
 */
export function extractV3Swaps(data: string): DecodedV3Swap[] {
  const decoded = decodeUniversalRouter(data);
  if (!decoded) return [];
  return decoded.commands.filter((c): c is DecodedV3Swap =>
    c.kind === 'V3_SWAP_EXACT_IN' || c.kind === 'V3_SWAP_EXACT_OUT',
  );
}
