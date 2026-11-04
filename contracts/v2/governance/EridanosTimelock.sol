// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice Owner of the protocol's admin surface (ProtocolConfig, IntegratorRegistry, LaunchCore,
///         PoolManager). Proposer: the Safe multisig. Delay: 1 hour on testnet, 48 hours on mainnet.
contract EridanosTimelock is TimelockController {
    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors, address admin)
        TimelockController(minDelay, proposers, executors, admin)
    {}
}
