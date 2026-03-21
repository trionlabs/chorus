// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test, Vm} from "forge-std/Test.sol";
import {AgentConsensus} from "../src/AgentConsensus.sol";

contract MockDelegationManager {
    bool public called;
    bytes[] public lastContexts;

    function redeemDelegations(
        bytes[] calldata permissionContexts,
        bytes32[] calldata,
        bytes[] calldata
    ) external {
        called = true;
        for (uint256 i = 0; i < permissionContexts.length; i++) {
            lastContexts.push(permissionContexts[i]);
        }
    }
}

contract AgentConsensusTest is Test {
    using SafeFROST for SafeFROST.CLI;

    AgentConsensus consensus;
    MockDelegationManager mockDM;

    function setUp() external {
        consensus = new AgentConsensus();
        mockDM = new MockDelegationManager();
    }

    function test_registerCommittee() external {
        SafeFROST.CLI memory frost = SafeFROST.init(vm, "register");
        frost.exec("split", "--threshold", "2", "--signers", "3", "--force");

        (, uint256 px, uint256 py) =
            abi.decode(frost.exec("info", "--abi-encode", "public-key"), (address, uint256, uint256));

        bytes32 id = consensus.registerCommittee(px, py, 2);
        assertTrue(id != bytes32(0));

        (uint256 cpx,,,,, bool active) = consensus.committees(id);
        assertEq(cpx, px);
        assertTrue(active);
    }

    function test_executeDelegated() external {
        SafeFROST.CLI memory frost = SafeFROST.init(vm, "execute");
        frost.exec("split", "--threshold", "2", "--signers", "3", "--force");

        (, uint256 px, uint256 py) =
            abi.decode(frost.exec("info", "--abi-encode", "public-key"), (address, uint256, uint256));

        bytes32 committeeId = consensus.registerCommittee(px, py, 2);

        // build the delegation call data
        bytes[] memory contexts = new bytes[](1);
        contexts[0] = hex"deadbeef";
        bytes32[] memory modes = new bytes32[](1);
        modes[0] = bytes32(0);
        bytes[] memory execDatas = new bytes[](1);
        execDatas[0] = hex"cafe";

        bytes32 executionHash = keccak256(abi.encode(address(mockDM), contexts, modes, execDatas));
        bytes32 actionHash = consensus.getActionHash(committeeId, executionHash, 0);

        // FROST ceremony: 2-of-3 with participants 0 and 1
        frost.exec("commit", "--share-index", "0");
        frost.exec("commit", "--share-index", "1");
        frost.exec("prepare", "--message", vm.toString(actionHash));
        frost.exec("sign", "--share-index", "0");
        frost.exec("sign", "--share-index", "1");
        frost.exec("aggregate");

        (uint256 rx, uint256 ry, uint256 z) =
            abi.decode(frost.exec("info", "--abi-encode", "signature"), (uint256, uint256, uint256));

        consensus.executeDelegated(
            committeeId,
            address(mockDM),
            contexts,
            modes,
            execDatas,
            rx, ry, z
        );

        assertTrue(mockDM.called());
        assertEq(consensus.getNonce(committeeId), 1);
    }

    function test_rejectsInvalidSignature() external {
        SafeFROST.CLI memory frost = SafeFROST.init(vm, "reject");
        frost.exec("split", "--threshold", "2", "--signers", "3", "--force");

        (, uint256 px, uint256 py) =
            abi.decode(frost.exec("info", "--abi-encode", "public-key"), (address, uint256, uint256));

        bytes32 committeeId = consensus.registerCommittee(px, py, 2);

        bytes[] memory contexts = new bytes[](0);
        bytes32[] memory modes = new bytes32[](0);
        bytes[] memory execDatas = new bytes[](0);

        // use bogus signature values
        vm.expectRevert(AgentConsensus.InvalidSignature.selector);
        consensus.executeDelegated(
            committeeId,
            address(mockDM),
            contexts, modes, execDatas,
            1, 1, 1
        );
    }

    function test_rejectsReplay() external {
        SafeFROST.CLI memory frost = SafeFROST.init(vm, "replay");
        frost.exec("split", "--threshold", "2", "--signers", "3", "--force");

        (, uint256 px, uint256 py) =
            abi.decode(frost.exec("info", "--abi-encode", "public-key"), (address, uint256, uint256));

        bytes32 committeeId = consensus.registerCommittee(px, py, 2);

        bytes[] memory contexts = new bytes[](1);
        contexts[0] = hex"aa";
        bytes32[] memory modes = new bytes32[](1);
        modes[0] = bytes32(0);
        bytes[] memory execDatas = new bytes[](1);
        execDatas[0] = hex"bb";

        bytes32 executionHash = keccak256(abi.encode(address(mockDM), contexts, modes, execDatas));
        bytes32 actionHash = consensus.getActionHash(committeeId, executionHash, 0);

        // first ceremony
        frost.exec("commit", "--share-index", "0");
        frost.exec("commit", "--share-index", "1");
        frost.exec("prepare", "--message", vm.toString(actionHash));
        frost.exec("sign", "--share-index", "0");
        frost.exec("sign", "--share-index", "1");
        frost.exec("aggregate");

        (uint256 rx, uint256 ry, uint256 z) =
            abi.decode(frost.exec("info", "--abi-encode", "signature"), (uint256, uint256, uint256));

        // first call succeeds
        consensus.executeDelegated(committeeId, address(mockDM), contexts, modes, execDatas, rx, ry, z);

        // replay with same sig fails (nonce incremented)
        vm.expectRevert(AgentConsensus.InvalidSignature.selector);
        consensus.executeDelegated(committeeId, address(mockDM), contexts, modes, execDatas, rx, ry, z);
    }
}

library SafeFROST {
    struct CLI {
        Vm vm;
        string root;
    }

    function init(Vm vm, string memory tag) internal pure returns (CLI memory) {
        return CLI(vm, string(abi.encodePacked(".frost/", tag)));
    }

    function exec(CLI memory self, string memory sub, string[] memory opts) internal returns (bytes memory) {
        string[] memory cmd = new string[](4 + opts.length);
        cmd[0] = "safe-frost";
        cmd[1] = "--root-directory";
        cmd[2] = self.root;
        cmd[3] = sub;
        for (uint256 i = 0; i < opts.length; i++) {
            cmd[4 + i] = opts[i];
        }
        return self.vm.ffi(cmd);
    }

    function exec(CLI memory self, string memory sub) internal returns (bytes memory) {
        return exec(self, sub, new string[](0));
    }

    function exec(CLI memory self, string memory sub, string memory a, string memory b)
        internal returns (bytes memory)
    {
        string[] memory opts = new string[](2);
        opts[0] = a;
        opts[1] = b;
        return exec(self, sub, opts);
    }

    function exec(CLI memory self, string memory sub, string memory a, string memory b, string memory c, string memory d)
        internal returns (bytes memory)
    {
        string[] memory opts = new string[](4);
        opts[0] = a;
        opts[1] = b;
        opts[2] = c;
        opts[3] = d;
        return exec(self, sub, opts);
    }

    function exec(CLI memory self, string memory sub, string memory a, string memory b, string memory c, string memory d, string memory e)
        internal returns (bytes memory)
    {
        string[] memory opts = new string[](5);
        opts[0] = a;
        opts[1] = b;
        opts[2] = c;
        opts[3] = d;
        opts[4] = e;
        return exec(self, sub, opts);
    }
}
