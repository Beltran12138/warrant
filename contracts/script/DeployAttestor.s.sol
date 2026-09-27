// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {WarrantRegistry} from "../src/WarrantRegistry.sol";
import {WarrantAttestor} from "../src/WarrantAttestor.sol";

/// REGISTRY=0x37cdFe2a144993dC3145367305fF66E29302E673 \
///   forge script script/DeployAttestor.s.sol --rpc-url <monad_testnet|fuji> --broadcast
contract DeployAttestor is Script {
    function run() external returns (WarrantAttestor att) {
        WarrantRegistry reg = WarrantRegistry(vm.envAddress("REGISTRY"));
        require(address(reg).code.length > 0, "REGISTRY has no code on this chain");
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        att = new WarrantAttestor(reg);
        vm.stopBroadcast();
        console.log("WarrantAttestor", address(att), "chainId", block.chainid);
    }
}
