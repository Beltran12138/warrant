// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";

/// forge script script/Deploy.s.sol --rpc-url <monad_testnet|fuji> --broadcast
contract Deploy is Script {
    function run() external returns (MandateRegistry reg) {
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        reg = new MandateRegistry();
        vm.stopBroadcast();
        console.log("MandateRegistry", address(reg), "chainId", block.chainid);
    }
}
