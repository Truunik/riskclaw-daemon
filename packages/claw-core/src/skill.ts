import type { ChainAdapter, ComputeAdapter, SignerAdapter, StorageAdapter } from './adapters.ts';

export interface ChainTarget {
  id: number;
  name: string;
  rpc: string;
  ws?: string;
}

export interface SkillManifest {
  name: string;
  description: string;
  chain: ChainTarget;
  adapters: {
    compute?: string;
    storage?: string;
    signer: string;
    chain: string;
  };
  streaming?: boolean;
  handlers?: string[];
}

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface SkillContext {
  compute?: ComputeAdapter;
  storage?: StorageAdapter;
  signer: SignerAdapter;
  chain: ChainAdapter;
  logger: Logger;
  env: Record<string, string | undefined>;
}

export type SkillHandler = (req: unknown, ctx: SkillContext) => Promise<unknown>;

export interface Skill {
  manifest: SkillManifest;
  start?(ctx: SkillContext): Promise<void>;
  stop?(): Promise<void>;
  handlers?: Record<string, SkillHandler>;
}
