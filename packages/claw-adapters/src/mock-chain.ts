import type { CallRequest, ChainAdapter, ChainEvent, ReadContractRequest, SubscribeFilter } from '@claw/core';

export class MockChain implements ChainAdapter {
  async call(_req: CallRequest): Promise<string> {
    return '0x';
  }

  async readContract<T = unknown>(_req: ReadContractRequest): Promise<T> {
    return undefined as T;
  }

  async getBlockNumber(): Promise<bigint> {
    return 0n;
  }

  async simulateAfter(_req: CallRequest & { afterTx: string }): Promise<string> {
    return '0x';
  }

  async subscribe(_filter: SubscribeFilter, _handler: (e: ChainEvent) => void): Promise<() => void> {
    return () => {};
  }
}
