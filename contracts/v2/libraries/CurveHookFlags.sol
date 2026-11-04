// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

/// @title CurveHookFlags
/// @notice The single source of truth for the permissions `CurveHook` registers with the Uniswap v4
///         PoolManager. In v4 the permissions are encoded in the low 14 bits of the hook address, so the
///         hook must be deployed (CREATE2, salt mined off-chain) at an address whose bits equal `FLAGS`.
///         See docs/desain/02-desain-arsitektur.md §5.2.
library CurveHookFlags {
    /// @dev beforeInitialize      — refuse pools using our hook that CurveHook did not create
    ///      beforeAddLiquidity    — refuse all third-party liquidity (closed pool)
    ///      beforeSwap            — override the LP fee to the base fee; charge the anti-sniper surcharge
    ///                              on exact-input swaps (beforeSwapReturnDelta)
    ///      afterSwap             — charge the surcharge on exact-output swaps (afterSwapReturnDelta)
    uint160 internal constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
        | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
        | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    function permissions() internal pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: true,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }
}
