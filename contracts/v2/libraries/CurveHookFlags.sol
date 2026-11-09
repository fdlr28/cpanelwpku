// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {
    HOOKS_BEFORE_INITIALIZE_OFFSET,
    HOOKS_BEFORE_ADD_LIQUIDITY_OFFSET,
    HOOKS_BEFORE_SWAP_OFFSET,
    HOOKS_AFTER_SWAP_OFFSET,
    HOOKS_BEFORE_SWAP_RETURNS_DELTA_OFFSET,
    HOOKS_AFTER_SWAP_RETURNS_DELTA_OFFSET
} from "../../vendor/infinity/src/pool-cl/interfaces/ICLHooks.sol";
import {CLPoolParametersHelper} from "../../vendor/infinity/src/pool-cl/libraries/CLPoolParametersHelper.sol";
import {EridanosConstants as C} from "./EridanosConstants.sol";

/// @title CurveHookFlags
/// @notice The single source of truth for the callbacks `CurveHook` registers with the PancakeSwap Infinity
///         CL pool manager. Infinity stores the registration bitmap in the low 16 bits of `PoolKey.parameters`
///         and checks it against `hook.getHooksRegistrationBitmap()` when a pool is initialised, so no address
///         mining is needed. See docs/desain/02-desain-arsitektur.md §5.
library CurveHookFlags {
    /// @dev beforeInitialize      — refuse pools using our hook that CurveHook did not create
    ///      beforeAddLiquidity    — refuse all third-party liquidity (closed pool)
    ///      beforeSwap            — override the LP fee to the base fee; charge the anti-sniper surcharge
    ///                              on exact-input swaps (beforeSwapReturnsDelta)
    ///      afterSwap             — charge the surcharge on exact-output swaps (afterSwapReturnsDelta)
    uint16 internal constant BITMAP = (uint16(1) << HOOKS_BEFORE_INITIALIZE_OFFSET)
        | (uint16(1) << HOOKS_BEFORE_ADD_LIQUIDITY_OFFSET) | (uint16(1) << HOOKS_BEFORE_SWAP_OFFSET)
        | (uint16(1) << HOOKS_AFTER_SWAP_OFFSET) | (uint16(1) << HOOKS_BEFORE_SWAP_RETURNS_DELTA_OFFSET)
        | (uint16(1) << HOOKS_AFTER_SWAP_RETURNS_DELTA_OFFSET);

    /// @notice `PoolKey.parameters` of every Eridanos pool: the hook bitmap plus the tick spacing.
    function parameters() internal pure returns (bytes32) {
        return CLPoolParametersHelper.setTickSpacing(bytes32(uint256(BITMAP)), C.TICK_SPACING);
    }
}
