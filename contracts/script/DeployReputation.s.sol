// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {WarrantAttestor} from "../src/WarrantAttestor.sol";
import {WarrantReputation, IERC8004Identity, IERC8004Reputation} from "../src/WarrantReputation.sol";

/// ATTESTOR=0xC356ac5ebD7d249102D3C9c25764A8815c1718aA \
///   forge script script/DeployReputation.s.sol --rpc-url <monad_testnet|fuji> --broadcast
/// ERC-8004 v2.0.0 registries: the testnet addresses (Monad testnet, Fuji) are the defaults;
/// on Arc mainnet pass IDENTITY=0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 REPUTATION=0x8004BAa17C55a88189AE136b182e5fdA19dE9b63.
contract DeployReputation is Script {
    function run() external returns (WarrantReputation bridge) {
        address IDENTITY = vm.envOr("IDENTITY", 0x8004A818BFB912233c491871b3d84c89A494BD9e);
        address REPUTATION = vm.envOr("REPUTATION", 0x8004B663056A597Dffe9eCcC1965A193B7388713);
        address attestor = vm.envAddress("ATTESTOR");
        require(attestor.code.length > 0 && IDENTITY.code.length > 0 && REPUTATION.code.length > 0, "missing code");
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        bridge = new WarrantReputation(WarrantAttestor(attestor), IERC8004Identity(IDENTITY), IERC8004Reputation(REPUTATION));
        vm.stopBroadcast();
        console.log("WarrantReputation", address(bridge), "chainId", block.chainid);
    }
}
