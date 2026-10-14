// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC8183} from "../src/vendor/erc8183/ERC8183.sol";
import {WarrantPriceCheck} from "../src/WarrantPriceCheck.sol";
import {WarrantSwapJob} from "../src/WarrantSwapJob.sol";

/// Arc mainnet (5042): an ERC-8183 core (the reference implementation, behind an ERC1967 proxy; treasury and
/// admin = the deployer, no fees), WarrantSwapJob wired to it and to the deployed WarrantPriceCheck, the hook
/// whitelisted and Arc's ERC-20 USDC allowed as the payment token.
/// forge script script/DeploySwapJobArc.s.sol --rpc-url arc --broadcast
contract DeploySwapJobArc is Script {
    address constant PRICE_CHECK = 0xdF3fE689F0a3C74Ce299018cB573870769f04571;
    address constant USDC = 0x3600000000000000000000000000000000000000;

    function run() external {
        require(block.chainid == 5042, "not Arc mainnet");
        require(PRICE_CHECK.code.length > 0 && USDC.code.length > 0, "missing contracts");
        uint256 pk = vm.envUint("ARC_PRIVATE_KEY");
        address me = vm.addr(pk);
        vm.startBroadcast(pk);
        ERC8183 impl = new ERC8183();
        ERC8183 core = ERC8183(address(new ERC1967Proxy(address(impl), abi.encodeCall(ERC8183.initialize, (me, me)))));
        WarrantSwapJob hook = new WarrantSwapJob(core, WarrantPriceCheck(PRICE_CHECK), USDC);
        core.setHookWhitelist(address(hook), true);
        core.setPaymentTokenAllowed(USDC, true);
        vm.stopBroadcast();
        console.log("ERC8183 impl    ", address(impl));
        console.log("ERC8183 (proxy) ", address(core));
        console.log("WarrantSwapJob  ", address(hook));
    }
}
