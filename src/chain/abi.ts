export const agentConsensusAbi = [
  {
    name: "registerCommittee",
    type: "function",
    inputs: [
      { name: "px", type: "uint256" },
      { name: "py", type: "uint256" },
      { name: "threshold", type: "uint256" },
    ],
    outputs: [{ name: "id", type: "bytes32" }],
    stateMutability: "nonpayable",
  },
  {
    name: "executeDelegated",
    type: "function",
    inputs: [
      { name: "committeeId", type: "bytes32" },
      { name: "delegationManager", type: "address" },
      { name: "permissionContexts", type: "bytes[]" },
      { name: "modes", type: "bytes32[]" },
      { name: "executionCallDatas", type: "bytes[]" },
      { name: "rx", type: "uint256" },
      { name: "ry", type: "uint256" },
      { name: "z", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "getActionHash",
    type: "function",
    inputs: [
      { name: "committeeId", type: "bytes32" },
      { name: "executionHash", type: "bytes32" },
      { name: "nonce", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "pure",
  },
  {
    name: "getNonce",
    type: "function",
    inputs: [{ name: "committeeId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    name: "committees",
    type: "function",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "px", type: "uint256" },
      { name: "py", type: "uint256" },
      { name: "signer", type: "address" },
      { name: "threshold", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "active", type: "bool" },
    ],
    stateMutability: "view",
  },
  {
    name: "CommitteeRegistered",
    type: "event",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "signer", type: "address", indexed: false },
      { name: "threshold", type: "uint256", indexed: false },
    ],
  },
  {
    name: "ConsensusReached",
    type: "event",
    inputs: [
      { name: "committeeId", type: "bytes32", indexed: true },
      { name: "actionHash", type: "bytes32", indexed: true },
      { name: "nonce", type: "uint256", indexed: false },
    ],
  },
  {
    name: "DelegationRedeemed",
    type: "event",
    inputs: [
      { name: "committeeId", type: "bytes32", indexed: true },
      { name: "delegationManager", type: "address", indexed: false },
      { name: "success", type: "bool", indexed: false },
    ],
  },
] as const;
