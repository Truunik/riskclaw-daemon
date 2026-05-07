export interface AnalysisInput {
  subjectId: string;
  metrics: Record<string, unknown>;
  prompt?: string;
}

export interface AnalysisResult {
  riskScoreBps: number;
  reasoning: string[];
  provider: string;
  responseId: string;
  attestation?: string;
  rawMemo: Uint8Array;
}

export interface ComputeAdapter {
  analyze(input: AnalysisInput): Promise<AnalysisResult>;
}

export type StorageKind = 'memo' | 'metrics' | 'log' | 'decision';

export interface StorageAdapter {
  put(blob: Uint8Array, kind: StorageKind): Promise<string>;
  get(root: string): Promise<Uint8Array>;
}

export interface TxRequest {
  to: string;
  data: string;
  value?: bigint;
  gas?: bigint;
}

export interface TxResult {
  hash: string;
  blockNumber?: number;
  status: 'pending' | 'success' | 'reverted';
}

export interface SignerAdapter {
  address(): string;
  send(tx: TxRequest): Promise<TxResult>;
}

export interface CallRequest {
  to: string;
  data: string;
  from?: string;
  value?: bigint;
}

export interface SubscribeFilter {
  kind: 'logs' | 'stateChanges' | 'miniBlocks';
  address?: string;
  topics?: string[];
  slots?: string[];
}

export interface ChainEvent {
  kind: 'log' | 'stateChange' | 'miniBlock';
  blockNumber: number;
  raw: unknown;
}

export interface ReadContractRequest {
  address: string;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  blockNumber?: bigint;
}

export interface ChainAdapter {
  call(req: CallRequest): Promise<string>;
  readContract<T = unknown>(req: ReadContractRequest): Promise<T>;
  getBlockNumber(): Promise<bigint>;
  /** Returns deployed runtime bytecode (0x-prefixed) or null if no code at address. */
  getCode(address: string): Promise<string | null>;
  simulateAfter?(req: CallRequest & { afterTx: string }): Promise<string>;
  subscribe?(filter: SubscribeFilter, handler: (event: ChainEvent) => void): Promise<() => void>;
}
