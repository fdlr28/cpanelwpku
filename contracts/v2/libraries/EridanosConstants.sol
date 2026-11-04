// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title EridanosConstants
/// @notice Protocol bounds that are part of the code, not settings. Changing any of them means deploying a
///         new version. Values follow docs/desain/02-desain-arsitektur.md §0 (decisions D2–D4) and §10.3.
library EridanosConstants {
    uint256 internal constant BPS = 10_000;

    // ---- supply (D4) -------------------------------------------------------------------------------
    uint256 internal constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 internal constant MAX_ALLOC_BPS = 2_000; // creator allocation ≤ 20%; instant (duration 0) allowed
    uint256 internal constant MAX_ALLOC_RECIPIENTS = 3;
    uint256 internal constant MAX_DEVBUY_BPS = 1_000; // dev buy ≤ 10% of supply, launch tx only

    // ---- fee split (D2) ----------------------------------------------------------------------------
    uint256 internal constant PROTOCOL_BPS = 2_000; // fixed 20% in every case
    uint256 internal constant MAX_INTEGRATOR_BPS = 3_000; // taken from the creator's share

    // ---- fee schedule (D3), Uniswap v4 pips (1e6 = 100%) -------------------------------------------
    uint24 internal constant START_FEE = 900_000; // 90%
    uint24 internal constant BASE_FEE = 10_000; // 1%
    uint256 internal constant DECAY_SECONDS = 10; // measured with block.timestamp only

    // ---- pool --------------------------------------------------------------------------------------
    int24 internal constant TICK_SPACING = 200;
    uint256 internal constant MAX_CURVE_BANDS = 16;

    // ---- integrators -------------------------------------------------------------------------------
    uint256 internal constant POLICY_DELAY = 24 hours;
    /// @dev Upper bound for any integrator-imposed minimum (cliff, vesting, dev-buy lock), so a policy can
    ///      never make launches impossible or overflow time arithmetic.
    uint256 internal constant MAX_POLICY_LOCK = 10 * 365 days;
}
