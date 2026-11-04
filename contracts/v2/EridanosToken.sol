// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EridanosConstants} from "./libraries/EridanosConstants.sol";

/// @title EridanosToken
/// @notice Plain fixed-supply ERC-20 created for every Eridanos launch.
///         - the whole supply is minted once, in the constructor, to `recipient` (the launch core),
///           which distributes all of it in the same transaction;
///         - no owner, no mint, no burn hook, no transfer tax, no blacklist, no transfer lock;
///         - name, symbol, decimals and metadata URI are immutable (requirement of the Elysium → HyperEVM
///           mirror bridge, which pairs tokens by their metadata).
contract EridanosToken is ERC20 {
    /// @notice The contract that created the token (provenance; carries no privileges).
    address public immutable launcher;
    /// @notice Off-chain metadata (image, description, socials). Set once, no setter exists.
    string public metadataURI;

    constructor(string memory name_, string memory symbol_, string memory metadataURI_, address recipient)
        ERC20(name_, symbol_)
    {
        launcher = msg.sender;
        metadataURI = metadataURI_;
        _mint(recipient, EridanosConstants.TOTAL_SUPPLY);
    }
}
