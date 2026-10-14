// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {WarrantPriceCheck} from "../src/WarrantPriceCheck.sol";
import {WarrantValidator, IERC8004Validation} from "../src/WarrantValidator.sol";

/// Arc mainnet (5042): WarrantValidator on the deployed WarrantPriceCheck and Arc's ERC-8004 v2.0.0 ValidationRegistry.
/// forge script script/DeployValidatorArc.s.sol --rpc-url arc --broadcast
contract DeployValidatorArc is Script {
    address constant PRICE_CHECK = 0xdF3fE689F0a3C74Ce299018cB573870769f04571;
    address constant VALIDATION = 0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58;

    function run() external {
        require(block.chainid == 5042, "not Arc mainnet");
        require(PRICE_CHECK.code.length > 0 && VALIDATION.code.length > 0, "missing contracts");
        vm.startBroadcast(vm.envUint("ARC_PRIVATE_KEY"));
        WarrantValidator v = new WarrantValidator(WarrantPriceCheck(PRICE_CHECK), IERC8004Validation(VALIDATION));
        vm.stopBroadcast();
        console.log("WarrantValidator", address(v));
    }
}
