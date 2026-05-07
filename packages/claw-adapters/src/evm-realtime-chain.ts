import { createPublicClient, http, webSocket, type Abi, type Hex, type PublicClient } from 'viem';
import type { CallRequest, ChainAdapter, ChainEvent, ReadContractRequest, SubscribeFilter } from '@claw/core';

export interface EvmChainConfig {
  rpcUrl: string;
  wsUrl?: string;
  chainId: number;
}

export class EvmRealtimeChain implements ChainAdapter {
  private http: PublicClient;
  private wsTransport?: ReturnType<typeof webSocket>;

  constructor(private cfg: EvmChainConfig) {
    this.http = createPublicClient({ transport: http(cfg.rpcUrl) });
    if (cfg.wsUrl) this.wsTransport = webSocket(cfg.wsUrl);
  }

  async call(req: CallRequest): Promise<string> {
    const r = await this.http.call({
      to: req.to as Hex,
      data: req.data as Hex,
      ...(req.from && { account: req.from as Hex }),
      ...(req.value !== undefined && { value: req.value }),
    });
    return r.data ?? '0x';
  }

  async readContract<T = unknown>(req: ReadContractRequest): Promise<T> {
    const result = await this.http.readContract({
      address: req.address as Hex,
      abi: req.abi as Abi,
      functionName: req.functionName,
      args: req.args as readonly unknown[] | undefined,
      ...(req.blockNumber !== undefined && { blockNumber: req.blockNumber }),
    });
    return result as T;
  }

  async getBlockNumber(): Promise<bigint> {
    return this.http.getBlockNumber();
  }

  async getCode(address: string): Promise<string | null> {
    const code = await this.http.getCode({ address: address as Hex });
    return code && code !== '0x' ? code : null;
  }

  async simulateAfter(req: CallRequest & { afterTx: string }): Promise<string> {
    // MegaETH-specific: gates simulation behind a prior tx confirming, via nonce.
    const r = await this.http.request({
      method: 'eth_callAfter' as 'eth_call',
      params: [
        { to: req.to, data: req.data, from: req.from },
        req.afterTx,
      ] as never,
    });
    return r as string;
  }

  async subscribe(filter: SubscribeFilter, handler: (e: ChainEvent) => void): Promise<() => void> {
    if (!this.wsTransport) throw new Error('subscribe requires wsUrl in EvmChainConfig');
    const inst = this.wsTransport({});
    const value = inst.value;
    if (!value || typeof (value as { subscribe?: unknown }).subscribe !== 'function') {
      throw new Error('ws transport does not expose subscribe');
    }
    const params = encodeFilter(filter);
    const sub = await (value as unknown as {
      subscribe: (args: {
        params: unknown;
        onData: (data: unknown) => void;
        onError: (err: Error) => void;
      }) => Promise<{ unsubscribe: () => Promise<unknown> }>;
    }).subscribe({
      params,
      onData: (data: unknown) => {
        const d = data as { blockNumber?: string | number; block_number?: string | number };
        handler({
          kind: filter.kind === 'miniBlocks' ? 'miniBlock' : filter.kind === 'stateChanges' ? 'stateChange' : 'log',
          blockNumber: Number(d.blockNumber ?? d.block_number ?? 0),
          raw: data,
        });
      },
      onError: (err: Error) => {
        console.error(`[chain] subscription error: ${err.message}`);
      },
    });
    return () => { void sub.unsubscribe(); };
  }
}

function encodeFilter(filter: SubscribeFilter): unknown[] {
  if (filter.kind === 'miniBlocks') return ['miniBlocks'];
  if (filter.kind === 'logs') {
    const f: Record<string, unknown> = {};
    if (filter.address) f.address = filter.address;
    if (filter.topics) f.topics = filter.topics;
    return ['logs', f];
  }
  if (filter.kind === 'stateChanges') {
    const f: Record<string, unknown> = {};
    if (filter.address) f.address = filter.address;
    if (filter.slots) f.slots = filter.slots;
    return ['stateChanges', f];
  }
  throw new Error(`unsupported subscribe kind: ${filter.kind}`);
}
