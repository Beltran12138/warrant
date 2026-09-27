// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {WarrantAttestor} from "../src/WarrantAttestor.sol";
import {WarrantReputation, IERC8004Identity, IERC8004Reputation} from "../src/WarrantReputation.sol";

/// ATTESTOR=0xC356ac5ebD7d249102D3C9c25764A8815c1718aA \
///   forge script script/DeployReputation.s.sol --rpc-url <monad_testnet|fuji> --broadcast
/// ERC-8004 v2.0.0 registries: same addresses on Monad testnet and Fuji.
contract DeployReputation is Script {
    address constant IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address constant REPUTATION = 0x8004B663056A597Dffe9eCcC1965A193B7388713;

    function run() external returns (WarrantReputation bridge) {
        address attestor = vm.envAddress("ATTESTOR");
        require(attestor.code.length > 0 && IDENTITY.code.length > 0 && REPUTATION.code.length > 0, "missing code");
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        bridge = new WarrantReputation(WarrantAttestor(attestor), IERC8004Identity(IDENTITY), IERC8004Reputation(REPUTATION));
        vm.stopBroadcast();
        console.log("WarrantReputation", address(bridge), "chainId", block.chainid);
    }
}
