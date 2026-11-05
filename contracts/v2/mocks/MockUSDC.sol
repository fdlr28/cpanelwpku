// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Local stand-in for USDC: 6 decimals like the real token, whole supply minted to the deployer.
contract MockUSDC is ERC20 {
    constructor(uint256 supply) ERC20("Mock USDC", "USDC") {
        _mint(msg.sender, supply);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}
