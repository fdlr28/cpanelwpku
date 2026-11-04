// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IDistributorClaims {
    function claimCreator(bytes32 poolId) external;
    function acceptCreator(bytes32 poolId) external;
}

/// @notice Test attacker: a creator contract that tries to claim again while receiving the first payout.
contract ReentrantClaimer {
    IDistributorClaims public immutable distributor;
    bytes32 public poolId;
    uint256 public reentryAttempts;
    bool public reentrySucceeded;

    constructor(IDistributorClaims distributor_) {
        distributor = distributor_;
    }

    function accept(bytes32 poolId_) external {
        poolId = poolId_;
        distributor.acceptCreator(poolId_);
    }

    function claim() external {
        distributor.claimCreator(poolId);
    }

    receive() external payable {
        reentryAttempts++;
        try distributor.claimCreator(poolId) {
            reentrySucceeded = true;
        } catch {}
    }
}
