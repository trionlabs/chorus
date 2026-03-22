// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.29;

import {FROST} from "safe-frost/contracts/FROST.sol";

/// @title AgentConsensus
/// @notice FROST threshold-signed agent committee with delegation-only execution.
/// The committee has no independent authority - it can only act within
/// delegated permissions via ERC-7710 DelegationManager.
contract AgentConsensus {
    struct Committee {
        uint256 px;
        uint256 py;
        address signer;
        uint256 threshold;
        uint256 nonce;
        bool active;
    }

    mapping(bytes32 => Committee) public committees;

    event CommitteeRegistered(bytes32 indexed id, address signer, uint256 threshold);
    event ConsensusReached(bytes32 indexed committeeId, bytes32 indexed actionHash, uint256 nonce);
    event DelegationRedeemed(bytes32 indexed committeeId, address delegationManager, bool success);

    error InvalidPublicKey();
    error CommitteeAlreadyExists();
    error CommitteeNotFound();
    error InvalidSignature();
    error DelegationFailed();

    function registerCommittee(uint256 px, uint256 py, uint256 threshold) external returns (bytes32 id) {
        if (!FROST.isValidPublicKey(px, py)) revert InvalidPublicKey();

        id = keccak256(abi.encode(px, py));
        if (committees[id].active) revert CommitteeAlreadyExists();

        address signer = _computeSigner(px, py);
        committees[id] = Committee({
            px: px,
            py: py,
            signer: signer,
            threshold: threshold,
            nonce: 0,
            active: true
        });

        emit CommitteeRegistered(id, signer, threshold);
    }

    function executeDelegated(
        bytes32 committeeId,
        address delegationManager,
        bytes[] calldata permissionContexts,
        bytes32[] calldata modes,
        bytes[] calldata executionCallDatas,
        uint256 rx,
        uint256 ry,
        uint256 z
    ) external {
        Committee storage c = committees[committeeId];
        if (!c.active) revert CommitteeNotFound();

        bytes32 executionHash = keccak256(abi.encode(delegationManager, permissionContexts, modes, executionCallDatas));
        bytes32 actionHash = getActionHash(committeeId, executionHash, c.nonce);

        address signer = FROST.verify(actionHash, c.px, c.py, rx, ry, z);
        if (signer != c.signer) revert InvalidSignature();

        c.nonce++;
        emit ConsensusReached(committeeId, actionHash, c.nonce - 1);

        (bool ok,) = delegationManager.call(
            abi.encodeWithSignature(
                "redeemDelegations(bytes[],bytes32[],bytes[])",
                permissionContexts,
                modes,
                executionCallDatas
            )
        );

        emit DelegationRedeemed(committeeId, delegationManager, ok);
        if (!ok) revert DelegationFailed();
    }

    function getActionHash(
        bytes32 committeeId,
        bytes32 executionHash,
        uint256 nonce
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(committeeId, executionHash, nonce));
    }

    function getNonce(bytes32 committeeId) external view returns (uint256) {
        return committees[committeeId].nonce;
    }

    function _computeSigner(uint256 px, uint256 py) private pure returns (address result) {
        assembly ("memory-safe") {
            mstore(0x00, px)
            mstore(0x20, py)
            result := and(keccak256(0x00, 0x40), 0xffffffffffffffffffffffffffffffffffffffff)
        }
    }
}
