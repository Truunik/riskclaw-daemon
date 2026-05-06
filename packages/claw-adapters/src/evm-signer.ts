import { createWalletClient, http, type Account, type Hex, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { SignerAdapter, TxRequest, TxResult } from '@claw/core';

export interface EvmSignerConfig {
  rpcUrl: string;
  privateKey: Hex;
  chainId: number;
  // MegaETH-only: realtime_sendRawTransaction returns the receipt in one round-trip.
  useRealtime?: boolean;
}

export class EvmSigner implements SignerAdapter {
  private wallet: WalletClient;
  private acct: Account;

  constructor(private cfg: EvmSignerConfig) {
    this.acct = privateKeyToAccount(cfg.privateKey);
    this.wallet = createWalletClient({
      account: this.acct,
      transport: http(cfg.rpcUrl),
    });
  }

  address(): string {
    return this.acct.address;
  }

  async send(tx: TxRequest): Promise<TxResult> {
    const prepared = await this.wallet.prepareTransactionRequest({
      account: this.acct,
      chain: null,
      to: tx.to as Hex,
      data: tx.data as Hex,
      ...(tx.value !== undefined && { value: tx.value }),
      ...(tx.gas !== undefined && { gas: tx.gas }),
    });
    const signed = await this.wallet.signTransaction(prepared as Parameters<WalletClient['signTransaction']>[0]);

    if (this.cfg.useRealtime) {
      const receipt = await this.wallet.request({
        method: 'realtime_sendRawTransaction' as 'eth_sendRawTransaction',
        params: [signed],
      } as never) as {
        transactionHash?: string;
        hash?: string;
        blockNumber?: string;
        status?: string;
      };
      const status = receipt.status === '0x1' || receipt.status === 'success' ? 'success' : 'reverted';
      return {
        hash: (receipt.transactionHash ?? receipt.hash ?? '0x') as string,
        blockNumber: receipt.blockNumber ? Number(receipt.blockNumber) : undefined,
        status,
      };
    }

    const hash = await this.wallet.sendRawTransaction({ serializedTransaction: signed });
    return { hash, status: 'pending' };
  }
}
