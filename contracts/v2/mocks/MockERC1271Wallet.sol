// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Smart-contract signer for tests: valid when its owner EOA signed the digest.
contract MockERC1271Wallet {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        (address recovered,,) = ECDSA.tryRecover(digest, signature);
        return recovered == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
