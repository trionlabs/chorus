// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.29;

import {Test, Vm} from "forge-std/Test.sol";
import {FROST} from "safe-frost/contracts/FROST.sol";
import {AgentConsensus} from "../src/AgentConsensus.sol";

contract GasBenchmarkTest is Test {
    using SafeFROST for SafeFROST.CLI;

    AgentConsensus consensus;

    function setUp() external {
        consensus = new AgentConsensus();
    }

    function test_gasFrostVerify() external {
        SafeFROST.CLI memory frost = SafeFROST.init(vm, "bench-frost");
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

        bytes32 executionHash = keccak256(abi.encode(address(this), contexts, modes, execDatas));
        bytes32 actionHash = consensus.getActionHash(committeeId, executionHash, 0);

        frost.exec("commit", "--share-index", "0");
        frost.exec("commit", "--share-index", "1");
        frost.exec("prepare", "--message", vm.toString(actionHash));
        frost.exec("sign", "--share-index", "0");
        frost.exec("sign", "--share-index", "1");
        frost.exec("aggregate");

        (uint256 rx, uint256 ry, uint256 z) =
            abi.decode(frost.exec("info", "--abi-encode", "signature"), (uint256, uint256, uint256));

        // measure FROST.verify in isolation
        uint256 gasBefore = gasleft();
        address signer = FROST.verify(actionHash, px, py, rx, ry, z);
        uint256 gasUsed = gasBefore - gasleft();

        assertTrue(signer != address(0), "FROST verify failed");
        emit log_named_uint("FROST.verify gas", gasUsed);
    }

    function test_gasEcrecoverSingle() external {
        // measure single ecrecover (what Safe uses per signer)
        bytes32 hash = keccak256("test message");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(1, hash);

        uint256 gasBefore = gasleft();
        address recovered = ecrecover(hash, v, r, s);
        uint256 gasUsed = gasBefore - gasleft();

        assertTrue(recovered != address(0));
        emit log_named_uint("ecrecover (1 signer) gas", gasUsed);
    }

    function test_gasEcrecoverMultiple() external {
        bytes32 hash = keccak256("test message");

        // 2-of-3 (Safe multisig style)
        uint256 gasBefore = gasleft();
        for (uint256 i = 1; i <= 2; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(i, hash);
            ecrecover(hash, v, r, s);
        }
        uint256 gas2of3 = gasBefore - gasleft();
        emit log_named_uint("ecrecover 2-of-3 gas", gas2of3);

        // 3-of-5
        gasBefore = gasleft();
        for (uint256 i = 1; i <= 3; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(i, hash);
            ecrecover(hash, v, r, s);
        }
        uint256 gas3of5 = gasBefore - gasleft();
        emit log_named_uint("ecrecover 3-of-5 gas", gas3of5);

        // 5-of-10
        gasBefore = gasleft();
        for (uint256 i = 1; i <= 5; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(i, hash);
            ecrecover(hash, v, r, s);
        }
        uint256 gas5of10 = gasBefore - gasleft();
        emit log_named_uint("ecrecover 5-of-10 gas", gas5of10);

        // 10-of-20
        gasBefore = gasleft();
        for (uint256 i = 1; i <= 10; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(i, hash);
            ecrecover(hash, v, r, s);
        }
        uint256 gas10of20 = gasBefore - gasleft();
        emit log_named_uint("ecrecover 10-of-20 gas", gas10of20);

        // 50-of-100
        gasBefore = gasleft();
        for (uint256 i = 1; i <= 50; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(i, hash);
            ecrecover(hash, v, r, s);
        }
        uint256 gas50of100 = gasBefore - gasleft();
        emit log_named_uint("ecrecover 50-of-100 gas", gas50of100);
    }

    function test_gasExecuteDelegated() external {
        SafeFROST.CLI memory frost = SafeFROST.init(vm, "bench-exec");
        frost.exec("split", "--threshold", "2", "--signers", "3", "--force");

        (, uint256 px, uint256 py) =
            abi.decode(frost.exec("info", "--abi-encode", "public-key"), (address, uint256, uint256));

        bytes32 committeeId = consensus.registerCommittee(px, py, 2);

        bytes[] memory contexts = new bytes[](1);
        contexts[0] = hex"deadbeef";
        bytes32[] memory modes = new bytes32[](1);
        modes[0] = bytes32(0);
        bytes[] memory execDatas = new bytes[](1);
        execDatas[0] = hex"cafe";

        bytes32 executionHash = keccak256(abi.encode(address(this), contexts, modes, execDatas));
        bytes32 actionHash = consensus.getActionHash(committeeId, executionHash, 0);

        frost.exec("commit", "--share-index", "0");
        frost.exec("commit", "--share-index", "1");
        frost.exec("prepare", "--message", vm.toString(actionHash));
        frost.exec("sign", "--share-index", "0");
        frost.exec("sign", "--share-index", "1");
        frost.exec("aggregate");

        (uint256 rx, uint256 ry, uint256 z) =
            abi.decode(frost.exec("info", "--abi-encode", "signature"), (uint256, uint256, uint256));

        uint256 gasBefore = gasleft();
        consensus.executeDelegated(committeeId, address(this), contexts, modes, execDatas, rx, ry, z);
        uint256 gasUsed = gasBefore - gasleft();

        emit log_named_uint("executeDelegated total gas", gasUsed);
    }

    // mock redeemDelegations so executeDelegated doesn't revert
    function redeemDelegations(bytes[] calldata, bytes32[] calldata, bytes[] calldata) external {}
}

library SafeFROST {
    struct CLI { Vm vm; string root; }

    function init(Vm vm, string memory tag) internal pure returns (CLI memory) {
        return CLI(vm, string(abi.encodePacked(".frost/", tag)));
    }

    function exec(CLI memory self, string memory sub, string[] memory opts) internal returns (bytes memory) {
        string[] memory cmd = new string[](4 + opts.length);
        cmd[0] = "safe-frost"; cmd[1] = "--root-directory"; cmd[2] = self.root; cmd[3] = sub;
        for (uint256 i = 0; i < opts.length; i++) cmd[4 + i] = opts[i];
        return self.vm.ffi(cmd);
    }

    function exec(CLI memory self, string memory sub) internal returns (bytes memory) {
        return exec(self, sub, new string[](0));
    }

    function exec(CLI memory self, string memory sub, string memory a, string memory b)
        internal returns (bytes memory)
    {
        string[] memory opts = new string[](2); opts[0] = a; opts[1] = b;
        return exec(self, sub, opts);
    }

    function exec(CLI memory self, string memory sub, string memory a, string memory b, string memory c, string memory d, string memory e)
        internal returns (bytes memory)
    {
        string[] memory opts = new string[](5); opts[0] = a; opts[1] = b; opts[2] = c; opts[3] = d; opts[4] = e;
        return exec(self, sub, opts);
    }
}
