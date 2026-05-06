import type { SignerAdapter, SkillContext, SkillManifest } from '@claw/core';
import {
  EvmRealtimeChain,
  EvmSigner,
  MockChain,
  MockCompute,
  MockSigner,
  MockStorage,
} from '@claw/adapters';
import { ConsoleLogger } from './logger.ts';

const MEGAETH_CHAIN_IDS = new Set([6343, 4326]);

export function buildContext(manifest: SkillManifest, env: NodeJS.ProcessEnv): SkillContext {
  const rpcUrl = pickRpc(manifest, env);
  const wsUrl = pickWs(manifest, env);
  const privateKey = pickPrivateKey(manifest, env);
  const chainId = manifest.chain.id;
  const isMega = MEGAETH_CHAIN_IDS.has(chainId);

  const chain = rpcUrl
    ? new EvmRealtimeChain({ rpcUrl, wsUrl, chainId })
    : new MockChain();

  const signer: SignerAdapter = privateKey && rpcUrl
    ? new EvmSigner({ rpcUrl, privateKey, chainId, useRealtime: isMega })
    : new MockSigner();

  return {
    compute: manifest.adapters.compute ? new MockCompute() : undefined,
    storage: manifest.adapters.storage ? new MockStorage() : undefined,
    signer,
    chain,
    logger: new ConsoleLogger(manifest.name),
    env: env as Record<string, string | undefined>,
  };
}

function pickRpc(m: SkillManifest, env: NodeJS.ProcessEnv): string | undefined {
  if (MEGAETH_CHAIN_IDS.has(m.chain.id)) return env.MEGAETH_RPC_URL ?? m.chain.rpc;
  if (m.chain.id === 16602) return env.OG_RPC_URL ?? m.chain.rpc;
  return m.chain.rpc;
}

function pickWs(m: SkillManifest, env: NodeJS.ProcessEnv): string | undefined {
  if (MEGAETH_CHAIN_IDS.has(m.chain.id)) return env.MEGAETH_WS_URL ?? m.chain.ws;
  return m.chain.ws;
}

function pickPrivateKey(m: SkillManifest, env: NodeJS.ProcessEnv): `0x${string}` | undefined {
  // Skill-declared signer kind controls which env key is read.
  if (m.adapters.signer === 'delegated') return env.DELEGATED_SIGNER_KEY as `0x${string}` | undefined;
  if (m.chain.id === 16602) return env.DEPLOYER_PRIVATE_KEY as `0x${string}` | undefined;
  return env.USER_PRIVATE_KEY as `0x${string}` | undefined;
}
