// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {AgentConsensus} from "../src/AgentConsensus.sol";

contract DeployScript is Script {
    function run() external {
        vm.startBroadcast();
        AgentConsensus consensus = new AgentConsensus();
        console.log("AgentConsensus deployed at:", address(consensus));
        vm.stopBroadcast();
    }
}
