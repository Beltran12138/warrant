// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title DemoUSD
/// @notice Testnet stand-in for the asset an agent trades with. Anyone can mint; it has no value.
contract DemoUSD is ERC20 {
    constructor() ERC20("Warrant Demo USD", "dUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
