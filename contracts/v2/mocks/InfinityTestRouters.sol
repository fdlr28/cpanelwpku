// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

// Test-only helpers: a plain ERC-20 and minimal routers that swap / modify liquidity on a PancakeSwap Infinity
// CL pool through a vault lock, the way any third-party router would. Never deployed outside local tests.
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IVault} from "../../vendor/infinity/src/interfaces/IVault.sol";
import {ILockCallback} from "../../vendor/infinity/src/interfaces/ILockCallback.sol";
import {ICLPoolManager} from "../../vendor/infinity/src/pool-cl/interfaces/ICLPoolManager.sol";
import {PoolKey} from "../../vendor/infinity/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "../../vendor/infinity/src/types/Currency.sol";
import {BalanceDelta} from "../../vendor/infinity/src/types/BalanceDelta.sol";

contract TestERC20 is ERC20 {
    constructor(uint256 supply) ERC20("Test", "TEST") {
        _mint(msg.sender, supply);
    }
}

abstract contract VaultLockRouter is ILockCallback {
    using CurrencyLibrary for Currency;

    IVault public immutable vault;
    ICLPoolManager public immutable poolManager;

    constructor(ICLPoolManager poolManager_) {
        poolManager = poolManager_;
        vault = poolManager_.vault();
    }

    receive() external payable {}

    /// @dev Pays what the caller owes the vault and sends what the vault owes the caller, for both currencies.
    function _settleAll(PoolKey memory key, BalanceDelta delta, address user) internal {
        _settleOne(key.currency0, delta.amount0(), user);
        _settleOne(key.currency1, delta.amount1(), user);
    }

    function _settleOne(Currency currency, int128 amount, address user) internal {
        if (amount < 0) {
            uint256 owed = uint256(uint128(-amount));
            if (currency.isNative()) {
                vault.settle{value: owed}();
            } else {
                vault.sync(currency);
                IERC20(Currency.unwrap(currency)).transferFrom(user, address(vault), owed);
                vault.settle();
            }
        } else if (amount > 0) {
            vault.take(currency, user, uint256(uint128(amount)));
        }
    }

    function _refundNative(address user) internal {
        uint256 left = address(this).balance;
        if (left != 0) {
            (bool ok,) = user.call{value: left}("");
            require(ok, "refund");
        }
    }
}

contract CLSwapTestRouter is VaultLockRouter {
    constructor(ICLPoolManager poolManager_) VaultLockRouter(poolManager_) {}

    function swap(PoolKey memory key, ICLPoolManager.SwapParams memory params, bytes memory hookData)
        external
        payable
        returns (BalanceDelta delta)
    {
        delta = abi.decode(vault.lock(abi.encode(msg.sender, key, params, hookData)), (BalanceDelta));
        _refundNative(msg.sender);
    }

    function lockAcquired(bytes calldata raw) external returns (bytes memory) {
        require(msg.sender == address(vault), "not vault");
        (address user, PoolKey memory key, ICLPoolManager.SwapParams memory params, bytes memory hookData) =
            abi.decode(raw, (address, PoolKey, ICLPoolManager.SwapParams, bytes));
        BalanceDelta delta = poolManager.swap(key, params, hookData);
        _settleAll(key, delta, user);
        return abi.encode(delta);
    }
}

contract CLLiquidityTestRouter is VaultLockRouter {
    constructor(ICLPoolManager poolManager_) VaultLockRouter(poolManager_) {}

    function modifyLiquidity(PoolKey memory key, ICLPoolManager.ModifyLiquidityParams memory params, bytes memory hookData)
        external
        payable
        returns (BalanceDelta delta)
    {
        delta = abi.decode(vault.lock(abi.encode(msg.sender, key, params, hookData)), (BalanceDelta));
        _refundNative(msg.sender);
    }

    function lockAcquired(bytes calldata raw) external returns (bytes memory) {
        require(msg.sender == address(vault), "not vault");
        (address user, PoolKey memory key, ICLPoolManager.ModifyLiquidityParams memory params, bytes memory hookData) =
            abi.decode(raw, (address, PoolKey, ICLPoolManager.ModifyLiquidityParams, bytes));
        (BalanceDelta delta,) = poolManager.modifyLiquidity(key, params, hookData);
        _settleAll(key, delta, user);
        return abi.encode(delta);
    }
}
