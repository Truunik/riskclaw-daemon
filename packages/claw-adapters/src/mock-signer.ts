import type { SignerAdapter, TxRequest, TxResult } from '@claw/core';

export class MockSigner implements SignerAdapter {
  constructor(private addr: string = '0x0000000000000000000000000000000000000000') {}

  address(): string {
    return this.addr;
  }

  async send(_tx: TxRequest): Promise<TxResult> {
    return { hash: `0x${'0'.repeat(64)}`, status: 'success' };
  }
}
