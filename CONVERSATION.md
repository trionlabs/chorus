# Conversation Log

Human-agent collaboration record for Chorus, built during The Synthesis hackathon. This captures the actual back-and-forth: what was proposed, what was rejected, where the human corrected the agent, and how the project evolved from an idea to a working system with real on-chain proof.

## Starting Point

We started by exploring the FROST threshold signature space - how multiple AI agents could collectively sign transactions without any single agent holding the full key. The question: how do we make this useful for The Synthesis?

The agent suggested using existing FROST libraries and building on top of them rather than implementing cryptography from scratch. We chose safe-frost (from Safe Research) as the foundation - a battle-tested Schnorr verifier for the EVM.

## The Pivot to Delegation-Only

Early architecture had the committee holding its own funds - a treasury that agents could spend from. The human pushed back: "The FROST should be only possible to execute tx from delegation with Alice's policies, nothing else."

This changed everything. The committee has zero independent authority. Every action flows through Alice's ERC-7710 delegation with on-chain caveat enforcement. Two layers of control: FROST consensus (did enough agents agree?) + delegation caveats (is the action within Alice's bounds?).

The agent initially kept adding a "direct execution" path as a fallback. The human kept removing it. The constraint made the architecture cleaner and the pitch stronger: "human delegates, agents operate within bounds, FROST proves they agreed."

## Agent Roles

The human wanted 3 named agents with distinct perspectives, not generic "Agent 1, 2, 3." We settled on:

- **Guard** (risk) - conservative, rejects anything above 3 USDC
- **Judge** (compliance) - strict, checks delegation caveats and allowed targets
- **Steward** (operations) - pragmatic, approves if the numbers work

The disagreement between them IS the demo. Guard flags a 5 USDC swap as too risky. Judge and Steward approve. 2-of-3 threshold met. The split decision is more compelling than unanimous approval.

## Choosing the Right Verifier

We initially considered building a custom Schnorr verifier with `(s, e)` signature format. The agent caught that safe-frost's FROST.sol uses a completely different format - `(rx, ry, z)` with RFC 9591 domain-separated hashing (`FROST-secp256k1-SHA256-v1chal` DST). These are cryptographically incompatible. Building a custom verifier would have produced something that couldn't verify signatures from the safe-frost CLI.

Decision: use FROST.sol directly as a Foundry dependency. One `forge install safe-research/safe-frost` and the verified library was available. The agent wrote AgentConsensus.sol in ~100 lines, importing FROST.sol for verification. 4 Foundry tests passed on first compile.

## The Function Selector Bug

The Uniswap swap kept failing with `AllowedMethodsEnforcer: method-not-allowed`. The agent had hardcoded `0x414bf389` as the exactInputSingle selector - this is the OLD SwapRouter (v1) which has a `deadline` field in the struct. Base Sepolia runs SwapRouter02 which uses a 7-field tuple without deadline. The correct selector is `0x04e45aaf`.

The MetaMask AllowedMethodsEnforcer just says "method-not-allowed" without telling you which selector it received vs which it expected. Silent failure. Cost about 30 minutes of debugging.

## XMTP Integration

Three subtleties the agent had to handle:

1. **Self-delivery**: XMTP streams exclude the sender's own messages. If Agent 1 broadcasts `frost/accept`, Agent 1's own state machine never sees it. The agent implemented manual self-delivery - after sending, pass the message to the local handler so the state machine advances.

2. **DM-only enforcement**: DKG round 2 messages contain secret key shares. If they arrive in a group chat, drop them and log a security violation. Implemented as a Set of message types that are DM-only.

3. **Coordinator routing**: The signing ceremony's SUBMIT_TX action was initially routed to the proposer (index 0 = Guard). But Guard rejected the proposal. Nobody submitted the signature on-chain. Fixed by routing to the coordinator (lowest accepted index), which is how FROST is supposed to work.

The XMTP native bindings had a Nix store path hardcoded for libiconv. The pre-built binary referenced `/nix/store/.../libiconv.2.dylib` which doesn't exist on macOS. Fixed with `install_name_tool` to repoint to homebrew's libiconv + `codesign` to re-sign.

## Making Delegation Real

The agent kept using mock delegation data (`0xdead`, `0xcafe` as permission contexts). The human caught this: "How does ETH move if we delegate only Uniswap and only < 100 USDC?"

Fair point. The "delegation-only" claim was hollow if the demo uses fake data. We went through several iterations:

1. Deployed Alice's HybridDeleGator smart account via MetaMask's SimpleFactory. First attempt failed (salt was bytes1, factory expected bytes32). Second attempt used `getFactoryArgs()` from the toolkit's smart account object - worked.

2. Created a real ERC-7710 delegation with caveats: AllowedTargets (Uniswap Router + USDC), AllowedMethods (exactInputSingle + approve), ERC20TransferAmount (100 USDC max).

3. Funded Alice's smart account with 20 test USDC.

4. Ran the full flow: FROST ceremony -> AgentConsensus verifies signature -> DelegationManager redeems delegation -> caveats enforced -> Uniswap executes swap -> 5 USDC converted to WETH.

Real USDC moved. No mock data. The XMTP demo was rewritten to use real delegation contexts end-to-end.

## ERC-8004 Registration

Registered the FROST committee as a single ERC-8004 identity on Base mainnet. The committee's group public key is the identity - externally it looks like one entity, internally it's 3 agents cooperating.

First registration used a `data:` URI for the metadata. The 8004scan.io explorer couldn't parse it. Switched to a GitHub raw URL, but GitHub serves `text/plain` with `nosniff`. Switched back to data URI. The scanner might have a bug. Either way, the on-chain registration is valid and the metadata is embedded in the transaction.

## Gas Benchmarks

The human wanted real numbers, not estimates. The agent wrote a Foundry gas benchmark test measuring FROST.verify() vs ecrecover (what Safe multisig uses per signer).

Measured results:
- FROST.verify: 5,327 gas (constant for any committee size)
- ecrecover 2-of-3: 10,391 gas
- ecrecover 10-of-20: 39,091 gas
- ecrecover 50-of-100: 195,207 gas

At 50-of-100, FROST costs the same as a single token transfer. A Safe multisig costs more than a Uniswap swap.

## AI-Powered Evaluation

The human pointed out the evaluator was fake - just `if (value > max) reject`. Added Claude-powered evaluation using @anthropic-ai/sdk. Each agent gets its system prompt (from config.ts) and Claude decides accept/reject with specific reasoning. Run with `--ai` flag or `USE_AI=true`.

The rule-based evaluator stays as the default for reliability. AI mode is opt-in.

## SKILL.md

The human wanted a detailed skill document so that any agent (not just our code) could join the committee. The SKILL.md grew from a brief overview to a full protocol specification: every XMTP message type with JSON examples, step-by-step ceremony flows, action hash computation formula, safety rules, CLI reference, and contract addresses.

An agent reading SKILL.md has everything it needs to participate in the FROST committee - no dependency on our TypeScript codebase.

## The Human's Role

The human's contributions were primarily architectural and quality control:
- Insisted on delegation-only execution (no independent authority)
- Caught the mock data inconsistency
- Pushed for real Uniswap swaps with real USDC
- Named the agents (Guard, Judge, Steward) with distinct evaluation perspectives
- Caught the USDC vs ETH policy mismatch in agent configs
- Demanded measured gas benchmarks, not estimates
- Funded the smart account and deployer address
- Reviewed every on-chain transaction on BaseScan

The agent's contributions were implementation:
- Wrote AgentConsensus.sol and all TypeScript code
- Designed the XMTP message protocol and ceremony state machine
- Debugged the function selector issue, XMTP bindings, salt encoding
- Wrote all deployment and test scripts
- Produced the gas benchmark test
- Registered the committee on ERC-8004

## What Worked

- safe-frost as a dependency. Battle-tested Schnorr verification at 5,327 gas.
- Building the contract first and testing with Foundry. Caught issues before any TypeScript existed.
- The human's insistence on "no mock data" forced us to build the real thing.
- XMTP self-delivery pattern prevented state machine desync bugs.
- Micro-commits. 40+ commits, each doing one thing.

## What Was Hard

- MetaMask delegation toolkit has viem version conflicts. Had to use `as any` casts.
- The function selector mismatch was a silent failure with unhelpful error messages.
- Account nonce race conditions between sequential on-chain calls.
- The XMTP native bindings Nix path issue was completely unexpected.
- ERC-8004 scanner couldn't parse our metadata despite valid on-chain data.

## On-Chain Artifacts

All on Base Sepolia unless noted.

- AgentConsensus (verified): [0xda9F141BEA3d4472dd4c17c0102d833Ec0202EB4](https://sepolia.basescan.org/address/0xda9F141BEA3d4472dd4c17c0102d833Ec0202EB4)
- Alice HybridDeleGator: [0x0F85A0959004918a95c4ECD8EA9d93e5b8C2fC52](https://sepolia.basescan.org/address/0x0F85A0959004918a95c4ECD8EA9d93e5b8C2fC52)
- Committee registration: [0xd258a3dc...](https://sepolia.basescan.org/tx/0xd258a3dc2e6104cf280ace827423be4d4cc829b3759afc44476762b0a4c8a7f6)
- FROST execution (local): [0x61192530...](https://sepolia.basescan.org/tx/0x61192530a76162f8546af7cc24e365720ec58a88b7f0308fc2d11b1dbc94ab3b)
- FROST execution (XMTP): [0x51085b15...](https://sepolia.basescan.org/tx/0x51085b15432611534ca9a41aa65d253528627d5d83c1fc7a0003ab2f39732edc)
- FROST + delegation (ETH transfer): [0x4b852118...](https://sepolia.basescan.org/tx/0x4b852118d404914bf0775ad4e4b37cb2ae6e8f6324e1995a405248aeff4cb787)
- FROST + delegation + Uniswap swap: [0x9137adb6...](https://sepolia.basescan.org/tx/0x9137adb6451de5abe13fda76cdba417c9a05624af1ac307fec7fd85717d5227d)
- FROST + delegation + Uniswap (XMTP): [0x109b1689...](https://sepolia.basescan.org/tx/0x109b168980bae7bdbf138c1d1a56a0e94597d09ca43d2a9d2d2f0a8453fe4b34)
- ERC-8004 committee (Base mainnet): [0xc4387b14...](https://basescan.org/tx/0xc4387b146e1ef8502bb503dbf03b41ccd0cf9b160b80ed139393b214c8672f2a)

**Base mainnet:**
- AgentConsensus (verified): [0xEE185FD0...](https://basescan.org/address/0xEE185FD094A4624B95120CBa8180c92f51794162)
- FROST execution: [0x6bea2ec9...](https://basescan.org/tx/0x6bea2ec95bb4e679231274179e23e882117d7149dc7b8a309b49afbcb77ff59a)
- Uniswap swap (2 USDC -> WETH): [0x1b9b9cca...](https://basescan.org/tx/0x1b9b9cca4ae7082344ccbec1032548120ff100936a756b67b1a4ec0cb71ca518)
- XMTP ceremony + swap (5 USDC -> WETH): [0xbde553f3...](https://basescan.org/tx/0xbde553f3d87868d35809839348b8daa567abcbad02a2f4fd2d0db201465545dd)
