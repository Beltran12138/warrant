// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {AgentMandate} from "../contracts/AgentMandate.sol";
import {ComplianceProvider} from "../contracts/ComplianceProvider.sol";
import {IAgentMandate} from "../contracts/interfaces/IAgentMandate.sol";
import {RamsGatedURWA20} from "../contracts/mocks/RamsGatedURWA20.sol";

/// Deploys the unmodified ERC-8226 reference implementation for the Warrant demo:
/// a compliance provider, the RAMS registry and a RAMS-gated ERC-7943 asset standing in for a
/// tokenized bond. The deployer is operator and admin of all three (testnet only).
///   forge script script/DeployRams.s.sol --rpc-url monad_testnet --broadcast
contract DeployRams is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        vm.startBroadcast(pk);
        ComplianceProvider provider = new ComplianceProvider(deployer);
        AgentMandate rams = new AgentMandate(deployer);
        RamsGatedURWA20 bond = new RamsGatedURWA20("Warrant Demo Bond", "wDBOND", deployer, IAgentMandate(address(rams)));
        vm.stopBroadcast();
        console.log("ComplianceProvider", address(provider));
        console.log("AgentMandate      ", address(rams));
        console.log("RamsGatedURWA20   ", address(bond));
    }
}
