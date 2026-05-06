import type { AnalysisInput, AnalysisResult, ComputeAdapter } from '@claw/core';

export class MockCompute implements ComputeAdapter {
  async analyze(input: AnalysisInput): Promise<AnalysisResult> {
    const score = heuristic(input.metrics);
    const memo = JSON.stringify({ subjectId: input.subjectId, score, ts: Date.now() });
    return {
      riskScoreBps: score,
      reasoning: ['heuristic mock — wire a TEE compute adapter (0G or Phala) for production'],
      provider: 'mock',
      responseId: `mock-${Date.now()}`,
      rawMemo: new TextEncoder().encode(memo),
    };
  }
}

function heuristic(m: Record<string, unknown>): number {
  const drift = Number(m.tvlDelta24hBps ?? 0);
  const impact = Number(m.priceImpactBps ?? 0);
  const swap = Number(m.lastSwapAmountBps ?? 0);
  const raw = Math.abs(drift) / 2 + impact * 3 + swap;
  return Math.min(10000, Math.max(0, Math.round(raw)));
}
