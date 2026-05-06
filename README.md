# riskclaw-daemon

**A real-time risk preflight daemon for MegaETH DeFi.**

*Built by a maintainer on the [Xerberus.io](https://xerberus.io) team. Continuation of [RiskClaw](https://github.com/Truunik/RiskClaw), our ETHGlobal agentic hackathon submission.*

riskclaw-daemon decodes a user's proposed transaction, derives the destination
contract state via CREATE2, reads live pool/position data, and returns
ALLOW / WARN / BLOCK *before the wallet broadcasts*. On MegaETH's 1s EVM
blocks, the entire preflight loop fits in the signing path.

The original RiskClaw moves risk policy onchain via a Uniswap v4 hook. This
daemon takes the same instinct off-pool: same Observer / Analyst / Guardian
shape, but the chain itself is fast enough that a hook isn't needed.

## Demo

One command, MegaETH mainnet, real Kumbaya pool, no special access:

```bash
$ claw preflight kumbaya 0xbc91070ad1B65B8EBec3a71bF8bA6b212f130Ca3 1e18 0
```

```json
{
  "decision": "BLOCK",
  "riskScoreBps": 9000,
  "reasons": [
    "amountOutMinimum=0 — zero slippage protection; vulnerable to MEV sandwich attacks",
    "pool 0xbc91070a…: shallow oracle cardinality: 1",
    "simulation reverted (likely missing approval or balance): STF"
  ],
  "kumbaya": {
    "recognized": "swap",
    "swap": { "kind": "exactInputSingle", "tokenIn": "0x12260260…", "tokenOut": "0x4200…0006", "fee": 10000, "amountOutMinimum": "0" },
    "poolRisk": { "riskBps": 500, "components": { "tvlDriftBps": 0, "inactiveLiquidity": false, "oracleHealthBps": 1000 } }
  }
}
```

Three independent risk vectors caught in one preflight call. Reproducible
against any public MegaETH RPC.

## Quickstart

```bash
git clone https://github.com/Truunik/riskclaw-daemon
cd riskclaw-daemon
bun install
bun run skills
```

Run the demo (defaults to MegaETH mainnet, chainId 4326):

```bash
bun run claw preflight kumbaya 0xbc91070ad1B65B8EBec3a71bF8bA6b212f130Ca3 1e18 0
```

Or against testnet (Carrot, chainId 6343):

```bash
MEGAETH_CHAIN_ID=6343 bun run claw preflight kumbaya \
  0x1EE2f89CD8a025D3262eC8C7e817AAB42Bc61a75 1e18 0
```

## Architecture

```
riskclaw-daemon/
  packages/
    claw-core/        Skill + adapter interfaces (zero deps)
    claw-adapters/    Real EVM (viem) + mock implementations
    claw-protocols/   One folder per protocol — kumbaya/, prism/ (next), tulpea/ (next)
  apps/
    daemon/           Skill registry + per-skill context builder
    cli/              `claw skills | run | invoke | preflight`
  skills/
    0g-uniswap-hook/    Hackathon thesis ported onto the kernel
    mega-vault-exiter/  Bounded-delegation auto-exiter (vault positions)
    mega-preflight/     Pre-flight risk co-pilot (request/response)
    mega-aggregator/    DEX route scoring (request/response)
```

Each skill declares a `SkillManifest` (chain target, required adapters), then
implements either `start(ctx)` for streaming work or
`handlers.<name>(req, ctx)` for request/response work. The daemon wires
adapters into the skill via `SkillContext`.

## Skills

| Skill | Mode | Purpose |
|---|---|---|
| `0g-uniswap-hook` | streaming | v4-style hook + agent swarm enforcing per-pool risk policy on 0G Galileo (kernel port of the original RiskClaw hackathon thesis) |
| `mega-vault-exiter` | streaming | Subscribes to vault `stateChanges` on MegaETH; signs bounded-delegation withdraw on red signals |
| `mega-preflight` | request/response | Decodes a proposed user tx, returns ALLOW / WARN / BLOCK with structured reasoning |
| `mega-aggregator` | request/response | Scores DEX routes by live per-pool risk |

## Protocol decoders

| Protocol | Chain | Status |
|---|---|---|
| Kumbaya (Uniswap V3 fork) | MegaETH 4326, 6343 | live: pool risk + `exactInputSingle`/`exactOutputSingle` calldata decode + CREATE2 pool derivation |
| Prism vaults | MegaETH | next |
| Tulpea RWA lending | MegaETH | next |

## What the Kumbaya decoder catches today

- **Slippage protection**: flags `amountOutMinimum=0` (no MEV sandwich
  protection)
- **V3 oracle health**: surfaces `observationCardinality < 10` as
  unreliable-TWAP signal; `cardinality=1` means the TWAP is the most recent
  block's spot price, manipulable in a single block
- **Liquidity depth**: flags pools with `liquidity < 1e6` as thin / dead
- **TVL drift**: reads `balanceOf` at `latest` and `latest - 300` blocks
  (~5 min on 1s EVM blocks); flags >10% drift
- **Reentrancy state**: flags pools where `slot0.unlocked == false` at read
  time
- **Sim revert**: classifies revert reason; downgrades severity when the
  protocol context is recognized (e.g. STF revert during simulation usually
  means missing token approval, not a malicious target)

## Adding a new protocol

1. `mkdir packages/claw-protocols/src/<protocol>`
2. Add `addresses.ts` (per-chain contract addresses) and `abi.ts`
3. Implement the `SwapDecoder` (or future `LendingDecoder`) interface from
   `packages/claw-protocols/src/types.ts`
4. Register the decoder in `packages/claw-protocols/src/index.ts`
5. Wire into the relevant skill's decoder array

PRs welcome.

## MegaETH-specific primitives used

| Primitive | Where |
|---|---|
| `eth_subscribe miniBlocks / stateChanges` | `EvmRealtimeChain.subscribe` (used by streaming skills) |
| `realtime_sendRawTransaction` | `EvmSigner.send` when `useRealtime: true` (returns receipt in one round-trip) |
| `eth_callAfter` | `EvmRealtimeChain.simulateAfter` (gates simulation behind a prior tx confirming) |

Without these, the daemon still runs anywhere EVM, but the latency story
collapses to the same as Ethereum mainnet.

## Lineage

The original [RiskClaw](https://github.com/Truunik/RiskClaw) was an ETHGlobal
agentic hackathon submission targeting the 0G ecosystem prize: v4-compatible
PoolManager + RiskHook + RiskPolicyRegistry on 0G Galileo, three agents
(Observer, Analyst, Guardian) coordinating through 0G Storage, with TEE-
verified LLM analysis on 0G Compute. The hackathon repo stays frozen as the
ETHGlobal submission artifact; this daemon is the productized successor that
extends the same thesis to other chains and protocols.

## License

MIT
