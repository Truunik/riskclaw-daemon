import type { SkillContext } from '@claw/core';

export interface PoolRisk {
  protocol: string;
  poolAddress: string;
  riskBps: number;
  reasons: string[];
  components: {
    tvlDriftBps: number | null;
    spreadBps: number | null;
    inactiveLiquidity: boolean | null;
    oracleHealthBps: number | null;
  };
}

export interface ProtocolDecoder {
  name: string;
  supports(chainId: number): boolean;
  recognize(target: string, chainId: number): boolean;
}

export interface SwapDecoder extends ProtocolDecoder {
  scorePool(poolAddress: string, chainId: number, ctx: SkillContext): Promise<PoolRisk>;
}
