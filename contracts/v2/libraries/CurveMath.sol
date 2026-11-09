// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {TickMath} from "../../vendor/infinity/src/pool-cl/libraries/TickMath.sol";
import {FullMath} from "../../vendor/infinity/src/pool-cl/libraries/FullMath.sol";

/// @notice One band of a single-sided curve, in canonical tick space (token priced in quote, price rising
///         with the offset). See ProtocolConfig for validation rules.
struct CurveBand {
    int24 offsetLower;
    int24 offsetUpper;
    uint16 bps;
}

/// @title CurveMath
/// @notice Shared by ProtocolConfig (validation) and CurveHook (seeding) so both use identical math.
library CurveMath {
    /// @notice Pool-space ticks of a band for the given token ordering: as-is when the token is currency0,
    ///         mirrored when it is currency1.
    function bandTicks(bool tokenIs0, int24 startTick, CurveBand memory b)
        internal
        pure
        returns (int24 tickLower, int24 tickUpper)
    {
        (tickLower, tickUpper) = (startTick + b.offsetLower, startTick + b.offsetUpper);
        if (!tokenIs0) (tickLower, tickUpper) = (-tickUpper, -tickLower);
    }

    /// @notice Liquidity that places `amount` tokens single-sided in the band (v3/v4 periphery LiquidityAmounts
    ///         math). Returns 0 instead of truncating when the result does not fit in uint128.
    function bandLiquidity(bool tokenIs0, int24 startTick, CurveBand memory b, uint256 amount)
        internal
        pure
        returns (uint256 liquidity)
    {
        (int24 lo, int24 up) = bandTicks(tokenIs0, startTick, b);
        uint256 sqrtA = TickMath.getSqrtRatioAtTick(lo);
        uint256 sqrtB = TickMath.getSqrtRatioAtTick(up);
        if (tokenIs0) {
            // amount0 = L · (sqrtB − sqrtA) · Q96 / (sqrtA · sqrtB)
            liquidity = FullMath.mulDiv(amount, FullMath.mulDiv(sqrtA, sqrtB, 1 << 96), sqrtB - sqrtA);
        } else {
            // amount1 = L · (sqrtB − sqrtA) / Q96
            liquidity = FullMath.mulDiv(amount, 1 << 96, sqrtB - sqrtA);
        }
        if (liquidity > type(uint128).max) liquidity = 0;
    }

    /// @notice Pool tick the pool is initialised at: one tick spacing outside the first band, so every band
    ///         starts out holding only the token.
    function startPoolTick(bool tokenIs0, int24 startTick, int24 tickSpacing) internal pure returns (int24) {
        return tokenIs0 ? startTick - tickSpacing : -startTick + tickSpacing;
    }
}
