// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {CurveHookFlags} from "../libraries/CurveHookFlags.sol";

/// @notice Phase-1 test double: registers exactly CurveHook's permission set against a PoolManager
///         given at deploy time, and records callbacks. No fee or liquidity logic.
contract DummyCurveHook {
    error NotPoolManager();

    IPoolManager public immutable poolManager;

    uint256 public beforeInitializeCalls;
    uint256 public beforeAddLiquidityCalls;
    uint256 public beforeSwapCalls;
    uint256 public afterSwapCalls;

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
        // Reverts with HookAddressNotValid unless this contract sits at an address whose low 14 bits
        // equal CurveHookFlags.FLAGS.
        Hooks.validateHookPermissions(IHooks(address(this)), CurveHookFlags.permissions());
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    function beforeInitialize(address, PoolKey calldata, uint160) external onlyPoolManager returns (bytes4) {
        beforeInitializeCalls++;
        return IHooks.beforeInitialize.selector;
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4)
    {
        beforeAddLiquidityCalls++;
        return IHooks.beforeAddLiquidity.selector;
    }

    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        beforeSwapCalls++;
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        afterSwapCalls++;
        return (IHooks.afterSwap.selector, 0);
    }
}
