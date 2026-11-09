// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {ICLPoolManager} from "../../vendor/infinity/src/pool-cl/interfaces/ICLPoolManager.sol";
import {ICLHooks} from "../../vendor/infinity/src/pool-cl/interfaces/ICLHooks.sol";
import {PoolKey} from "../../vendor/infinity/src/types/PoolKey.sol";
import {BalanceDelta} from "../../vendor/infinity/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "../../vendor/infinity/src/types/BeforeSwapDelta.sol";
import {CurveHookFlags} from "../libraries/CurveHookFlags.sol";

/// @notice Test double: registers exactly CurveHook's callback bitmap with the CL pool manager given at deploy
///         time, and records callbacks. No fee or liquidity logic.
contract DummyCurveHook is ICLHooks {
    error NotPoolManager();
    error NotRegistered();

    ICLPoolManager public immutable poolManager;

    uint256 public beforeInitializeCalls;
    uint256 public beforeAddLiquidityCalls;
    uint256 public beforeSwapCalls;
    uint256 public afterSwapCalls;

    constructor(ICLPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    function getHooksRegistrationBitmap() external pure returns (uint16) {
        return CurveHookFlags.BITMAP;
    }

    function beforeInitialize(address, PoolKey calldata, uint160) external onlyPoolManager returns (bytes4) {
        beforeInitializeCalls++;
        return ICLHooks.beforeInitialize.selector;
    }

    function beforeAddLiquidity(address, PoolKey calldata, ICLPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4)
    {
        beforeAddLiquidityCalls++;
        return ICLHooks.beforeAddLiquidity.selector;
    }

    function beforeSwap(address, PoolKey calldata, ICLPoolManager.SwapParams calldata, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        beforeSwapCalls++;
        return (ICLHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function afterSwap(address, PoolKey calldata, ICLPoolManager.SwapParams calldata, BalanceDelta, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        afterSwapCalls++;
        return (ICLHooks.afterSwap.selector, 0);
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert NotRegistered();
    }

    function afterAddLiquidity(address, PoolKey calldata, ICLPoolManager.ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, BalanceDelta)
    {
        revert NotRegistered();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ICLPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert NotRegistered();
    }

    function afterRemoveLiquidity(address, PoolKey calldata, ICLPoolManager.ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, BalanceDelta)
    {
        revert NotRegistered();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert NotRegistered();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert NotRegistered();
    }
}
