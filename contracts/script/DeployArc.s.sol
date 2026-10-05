// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {WarrantRegistry} from "../src/WarrantRegistry.sol";
import {WarrantAttestor} from "../src/WarrantAttestor.sol";
import {WarrantReputation, IERC8004Identity, IERC8004Reputation} from "../src/WarrantReputation.sol";

/// Arc mainnet (5042): the whole stack in one run, wired to Arc's ERC-8004 v2.0.0 registries, and the
/// principal (ARC_PRIVATE_KEY) grants AGENT (the mm wallet) warrant v1.
/// AGENT=<mm wallet> forge script script/DeployArc.s.sol --rpc-url arc --broadcast
contract DeployArc is Script {
    address constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant REPUTATION = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;

    function run() external {
        require(block.chainid == 5042, "not Arc mainnet");
        require(IDENTITY.code.length > 0 && REPUTATION.code.length > 0, "missing ERC-8004 registries");
        address agent = vm.envAddress("AGENT");
        vm.startBroadcast(vm.envUint("ARC_PRIVATE_KEY"));
        WarrantRegistry reg = new WarrantRegistry();
        WarrantAttestor att = new WarrantAttestor(reg);
        WarrantReputation bridge =
            new WarrantReputation(att, IERC8004Identity(IDENTITY), IERC8004Reputation(REPUTATION));
        // $1,000 per trade, 1% slippage, 1.5% price impact, 0.5% fees, cross-chain and new approvals allowed,
        // funds must return to the same wallet, no expiry: the same terms as the Monad testnet demo.
        reg.setWarrant(agent, WarrantRegistry.Warrant(100_000, 100, 150, 50, true, true, true, 0));
        vm.stopBroadcast();
        console.log("WarrantRegistry  ", address(reg));
        console.log("WarrantAttestor  ", address(att));
        console.log("WarrantReputation", address(bridge));
    }
}
