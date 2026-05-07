import type { SkillContext } from '@claw/core';

export interface PoolRisk {
  protocol: string;
  poolAddress: string;
  riskBps: number;
  reasons: string[];
  components: {
    tvlDriftBps: number | null;
    /** Optional medium-window (~2h) TVL drift in bps — null if not measured. */
    tvlDriftMediumBps: number | null;
    spreadBps: number | null;
    inactiveLiquidity: boolean | null;
    oracleHealthBps: number | null;
    tokenPatternBps: number | null;
    /** Stable-pair de-peg deviation in bps — null if pair is not stable/stable. */
    dePegDeviationBps: number | null;
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
