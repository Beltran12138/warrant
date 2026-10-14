// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {WarrantAttestor} from "../src/WarrantAttestor.sol";
import {IERC8004Identity, IERC8004Reputation} from "../src/WarrantReputation.sol";
import {WarrantPriceCheck, IAggregatorV3} from "../src/WarrantPriceCheck.sol";

/// Arc mainnet (5042): WarrantPriceCheck on the deployed WarrantAttestor, Arc's Chainlink USDC/USD and
/// EURC/USD feeds (24h heartbeat, 0.5% deviation threshold each, so 100 bps tolerance and a 25h max age),
/// and Arc's ERC-8004 v2.0.0 registries.
/// forge script script/DeployPriceCheckArc.s.sol --rpc-url arc --broadcast
contract DeployPriceCheckArc is Script {
    address constant ATTESTOR = 0x33B7B8db2927783dEbb58a589CF5c7B95824fae1;
    address constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant REPUTATION = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;
    address constant USDC_USD = 0x84EA90AC252Dc437031461836DB5164219147905;
    address constant EURC_USD = 0x361b95c10b76Ca3f35C686d423e43A951755Bf23;
    address constant EURC = 0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1;

    function run() external {
        require(block.chainid == 5042, "not Arc mainnet");
        require(ATTESTOR.code.length > 0 && USDC_USD.code.length > 0 && EURC_USD.code.length > 0, "missing contracts");

        address[] memory tokens = new address[](2);
        tokens[0] = address(0); // native USDC, 18 decimals
        tokens[1] = EURC;
        IAggregatorV3[] memory aggs = new IAggregatorV3[](2);
        aggs[0] = IAggregatorV3(USDC_USD);
        aggs[1] = IAggregatorV3(EURC_USD);
        uint8[] memory dec = new uint8[](2);
        dec[0] = 18;
        dec[1] = 6;
        uint32[] memory ages = new uint32[](2);
        ages[0] = 25 hours;
        ages[1] = 25 hours;

        vm.startBroadcast(vm.envUint("ARC_PRIVATE_KEY"));
        WarrantPriceCheck pc = new WarrantPriceCheck(
            WarrantAttestor(ATTESTOR), IERC8004Identity(IDENTITY), IERC8004Reputation(REPUTATION), 100, tokens, aggs, dec, ages
        );
        vm.stopBroadcast();
        console.log("WarrantPriceCheck", address(pc));
    }
}
