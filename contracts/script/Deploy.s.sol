// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {WarrantRegistry} from "../src/WarrantRegistry.sol";

/// forge script script/Deploy.s.sol --rpc-url <monad_testnet|fuji> --broadcast
contract Deploy is Script {
    function run() external returns (WarrantRegistry reg) {
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        reg = new WarrantRegistry();
        vm.stopBroadcast();
        console.log("WarrantRegistry", address(reg), "chainId", block.chainid);
    }
}
