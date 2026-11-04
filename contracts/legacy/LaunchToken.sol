// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title LaunchToken
/// @notice Fixed-supply ERC20 deployed by the launchpad for every new launch.
/// @dev The entire supply is minted to the launchpad, which sells it along a bonding curve and
///      seeds the DEX pool at graduation. Until graduation nobody but the launchpad may send
///      tokens to the DEX pair, so the pool cannot be seeded at a manipulated price.
contract LaunchToken is ERC20 {
    error OnlyLaunchpad();
    error PairAlreadySet();
    error TransferToPairBeforeGraduation();

    address public immutable launchpad;
    address public immutable creator;
    string public metadataURI;

    address public pair;
    bool public graduated;

    modifier onlyLaunchpad() {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        string memory metadataURI_,
        address creator_,
        uint256 totalSupply_
    ) ERC20(name_, symbol_) {
        launchpad = msg.sender;
        creator = creator_;
        metadataURI = metadataURI_;
        _mint(msg.sender, totalSupply_);
    }

    /// @notice Registers the DEX pair the token will graduate into. Called once at creation.
    function setPair(address pair_) external onlyLaunchpad {
        if (pair != address(0)) revert PairAlreadySet();
        pair = pair_;
    }

    /// @notice Unlocks transfers to the pair. Called by the launchpad after seeding liquidity.
    function markGraduated() external onlyLaunchpad {
        graduated = true;
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (!graduated && to == pair && to != address(0) && from != launchpad) {
            revert TransferToPairBeforeGraduation();
        }
        super._update(from, to, value);
    }

    /// @dev The launchpad can pull tokens for `sell` without a prior approve. The launchpad only
    ///      ever pulls from the account that called `sell`, so this saves users one transaction.
    function _spendAllowance(address owner, address spender, uint256 value) internal override {
        if (spender == launchpad) return;
        super._spendAllowance(owner, spender, value);
    }
}
