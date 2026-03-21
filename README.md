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
    Alice[Alice - human delegator]
    AC[AgentConsensus.sol<br/>Base Sepolia]
    DM[DelegationManager<br/>ERC-7710]
    FROST[FROST.sol<br/>~5,600 gas verification]
    XMTP[XMTP Group Chat<br/>E2E encrypted]

    Alice -->|ERC-7710 delegation<br/>caveated permissions| AC
    AC --> FROST
    AC -->|redeemDelegations| DM
    DM -->|caveat enforcement<br/>target + amount limits| Uniswap[Uniswap Router]

    Guard[Guard<br/>risk & security] --> XMTP
    Judge[Judge<br/>policy & compliance] --> XMTP
    Steward[Steward<br/>treasury & ops] --> XMTP

    XMTP -->|FROST ceremony<br/>commitments + shares| AC

    subgraph "Agent Committee (2-of-3)"
        Guard
        Judge
        Steward
    end
```

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

## Setup

```bash
# install safe-frost cli (requires rust)
cd contracts/lib/safe-frost && cargo install --path . && cd ../../..

# install dependencies
pnpm install

# generate frost keys (2-of-3)
safe-frost split --threshold 2 --signers 3

# run local demo
pnpm demo

# run foundry tests
cd contracts && forge test
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
- FROST-signed execution: [`0x61192530...`](https://sepolia.basescan.org/tx/0x61192530a76162f8546af7cc24e365720ec58a88b7f0308fc2d11b1dbc94ab3b)
- USDC: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
- Uniswap SwapRouter02: `0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4`

## Hackathon tracks

- **Synthesis Open Track** - agents that cooperate via FROST consensus
- **Agents With Receipts (ERC-8004)** - FROST signature as cryptographic receipt
- **Let the Agent Cook** - fully autonomous committee decisions
- **Best Use of Delegations** - human delegates to threshold committee via ERC-7710
- **Uniswap** - agents execute swaps within delegated bounds

Built for [The Synthesis](https://synthesis.md/hack/) hackathon.
