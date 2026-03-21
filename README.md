# Chorus

FROST threshold signatures as proof of multi-agent consensus on Ethereum.

A committee of AI agents independently evaluates proposals, reaches threshold agreement via FROST, and executes on-chain - all within human-delegated permissions (ERC-7710). The FROST signature is cryptographic proof that multiple agents agreed. 96 bytes, ~5,600 gas, constant cost regardless of committee size.

## How it works

```mermaid
sequenceDiagram
    participant Alice as Alice (human)
    participant AC as AgentConsensus.sol
    participant Guard
    participant Judge
    participant Steward
    participant Uniswap

    Alice->>AC: ERC-7710 delegation (max 100 USDC, Uniswap only)

    Note over Guard,Steward: Proposal: "Swap 50 USDC for ETH"

    Guard->>Guard: evaluate risk
    Judge->>Judge: check policy
    Steward->>Steward: check feasibility

    Guard--xGuard: REJECT (exceeds risk threshold)
    Judge->>Judge: ACCEPT
    Steward->>Steward: ACCEPT

    Note over Judge,Steward: 2-of-3 threshold met

    Judge->>Steward: FROST round 1 (commitments via XMTP)
    Steward->>Judge: FROST round 2 (signature shares via XMTP)
    Note over Judge,Steward: aggregate into 96-byte Schnorr signature

    Judge->>AC: executeDelegated(sig)
    AC->>AC: FROST.verify() (~5,600 gas)
    AC->>AC: redeem Alice's delegation
    AC->>Uniswap: swap 50 USDC for ETH (from Alice's account)
```

## Architecture

```mermaid
graph TB
    subgraph "Off-chain (XMTP E2E encrypted)"
        Guard[Guard<br/>risk & security]
        Judge[Judge<br/>policy & compliance]
        Steward[Steward<br/>treasury & ops]
        Guard <-->|FROST round 1+2| Judge
        Judge <-->|FROST round 1+2| Steward
    end

    subgraph "On-chain (Base Sepolia)"
        AC[AgentConsensus.sol]
        FROST[FROST.verify<br/>~5,600 gas, constant]
        DM[DelegationManager<br/>ERC-7710]
        Caveats[Caveat Enforcers<br/>AllowedTargets + AllowedMethods]
        Smart[Alice's Smart Account<br/>HybridDeleGator]
        Uniswap[Uniswap Router]
    end

    Alice[Alice - human] -->|signs ERC-7710 delegation<br/>max 100 USDC, Uniswap only| DM

    Judge -->|submit 96-byte<br/>FROST signature| AC
    AC -->|1. verify signature| FROST
    FROST -->|signer matches<br/>committee pubkey?| AC
    AC -->|2. call redeemDelegations<br/>with signed delegation + swap calldata| DM
    DM -->|3. enforce caveats| Caveats
    Caveats -->|4. execute from<br/>Alice's account| Smart
    Smart -->|5. swap USDC| Uniswap
```

The committee has no independent authority. Every action flows through two layers of verification:
1. **FROST consensus** - cryptographic proof that 2-of-3 agents agreed (off-chain, ~5,600 gas to verify)
2. **Delegation caveats** - on-chain policy enforcement by DelegationManager (target allowlist, method restrictions, amount limits)

## Signing ceremony

```mermaid
stateDiagram-v2
    [*] --> EVALUATING: proposal received
    EVALUATING --> ACCEPTED: threshold agents accept
    EVALUATING --> ABORTED: too many rejections
    ACCEPTED --> ROUND1_COMMITTED: commitments collected
    ROUND1_COMMITTED --> ROUND2_SIGNED: signature shares collected
    ROUND2_SIGNED --> EXECUTING: FROST signature aggregated
    EXECUTING --> COMPLETE: on-chain execution confirmed
    ACCEPTED --> ABORTED: timeout (30s)
    ROUND1_COMMITTED --> ABORTED: timeout (30s)
    ROUND2_SIGNED --> ABORTED: timeout (30s)
```

## Why FROST (not multisig)

| | FROST | Multisig |
|---|---|---|
| Proof size | 96 bytes (constant) | 65 * t bytes |
| Gas cost | ~5,600 (constant) | ~3,000 * t |
| Signer privacy | can't tell who signed | each signer revealed |
| On-chain appearance | one signer | visibly multi-party |
| Agent rotation | share refresh, same address | on-chain owner change |

FROST implements [RFC 9591](https://datatracker.ietf.org/doc/html/rfc9591) (Flexible Round-Optimized Schnorr Threshold signatures). See the [FROST Book](https://frost.zfnd.org) for the full protocol specification, DKG ceremony details, and security properties.

## Setup

```bash
# install safe-frost cli (requires rust)
cd contracts/lib/safe-frost && cargo install --path . && cd ../../..

# install dependencies
pnpm install

# generate frost keys (2-of-3)
safe-frost split --threshold 2 --signers 3

# run local demo (no xmtp, no chain)
pnpm demo

# run xmtp multi-agent demo (3 agents, frost ceremony, on-chain execution)
pnpm demo:xmtp

# run a standalone agent
AGENT_ROLE=guard AGENT_WALLET_KEY=0x... COMMITTEE_ID=0x... pnpm agent

# run foundry tests
cd contracts && forge test

# deploy contract to base sepolia
cd contracts && forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC --private-key $DEPLOYER_PRIVATE_KEY --broadcast

# register committee on-chain
npx tsx scripts/register-committee.ts

# create erc-7710 delegation (alice -> committee, uniswap + 100 usdc cap)
npx tsx scripts/create-delegation.ts
```

## Project structure

```
contracts/
  src/AgentConsensus.sol    - FROST-verified delegation-only execution
  test/AgentConsensus.t.sol - 4 passing tests (verify, delegate, replay, reject)
  lib/safe-frost/           - FROST.sol Schnorr verifier (~5,600 gas)

src/
  frost/cli.ts              - safe-frost CLI subprocess wrappers
  frost/executor.ts         - maps ceremony actions to CLI calls
  ceremony/signing.ts       - signing ceremony state machine
  ceremony/types.ts         - state enums, action types
  xmtp/agent.ts             - XMTP agent with self-delivery + DM enforcement
  xmtp/messages.ts          - protocol message types
  agent/handler.ts          - agent orchestration
  agent/evaluator.ts        - rule-based policy evaluation
  uniswap/client.ts         - Uniswap V3 swap builder
  chain/abi.ts              - AgentConsensus ABI
  chain/client.ts           - viem client for Base Sepolia

scripts/
  register-committee.ts     - on-chain committee registration
  create-delegation.ts      - ERC-7710 delegation with Uniswap caveats
  test-onchain.ts           - on-chain FROST verification test
```

## On-chain proof

- AgentConsensus: [`0xda9F141BEA3d4472dd4c17c0102d833Ec0202EB4`](https://sepolia.basescan.org/address/0xda9F141BEA3d4472dd4c17c0102d833Ec0202EB4)
- Committee registration: [`0xd258a3dc...`](https://sepolia.basescan.org/tx/0xd258a3dc2e6104cf280ace827423be4d4cc829b3759afc44476762b0a4c8a7f6)
- FROST-signed execution (local): [`0x61192530...`](https://sepolia.basescan.org/tx/0x61192530a76162f8546af7cc24e365720ec58a88b7f0308fc2d11b1dbc94ab3b)
- FROST-signed execution (XMTP): [`0x51085b15...`](https://sepolia.basescan.org/tx/0x51085b15432611534ca9a41aa65d253528627d5d83c1fc7a0003ab2f39732edc)
- Alice HybridDeleGator: [`0x0F85A095...`](https://sepolia.basescan.org/address/0x0F85A0959004918a95c4ECD8EA9d93e5b8C2fC52)
- DelegationManager: [`0xdb9B1e94...`](https://sepolia.basescan.org/address/0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3)
- Full flow (FROST + ERC-7710 delegation): [`0x4b852118...`](https://sepolia.basescan.org/tx/0x4b852118d404914bf0775ad4e4b37cb2ae6e8f6324e1995a405248aeff4cb787)
- USDC approve via FROST + delegation: [`0xa0930808...`](https://sepolia.basescan.org/tx/0xa0930808cdc8e338479b7ade8faf8bf5166fdbf6aa2047f7d821696a93c8ac14)
- Uniswap swap (5 USDC -> WETH) via FROST + delegation: [`0x9137adb6...`](https://sepolia.basescan.org/tx/0x9137adb6451de5abe13fda76cdba417c9a05624af1ac307fec7fd85717d5227d)
- ERC-8004 committee identity (Base mainnet): [`0xc4387b14...`](https://basescan.org/tx/0xc4387b146e1ef8502bb503dbf03b41ccd0cf9b160b80ed139393b214c8672f2a)
- USDC: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
- Uniswap SwapRouter02: `0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4`

## Hackathon tracks

- **Synthesis Open Track** - agents that cooperate via FROST consensus
- **Agents With Receipts (ERC-8004)** - FROST signature as cryptographic receipt
- **Let the Agent Cook** - fully autonomous committee decisions
- **Best Use of Delegations** - human delegates to threshold committee via ERC-7710
- **Uniswap** - agents execute swaps within delegated bounds

Built for [The Synthesis](https://synthesis.md/hack/) hackathon.
