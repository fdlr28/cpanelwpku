// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {LaunchCore} from "../LaunchCore.sol";
import {CurveHook} from "../CurveHook.sol";
import {ProtocolConfig} from "../ProtocolConfig.sol";
import {IntegratorRegistry} from "../IntegratorRegistry.sol";
import {CurveBand} from "../libraries/CurveMath.sol";

/// @title HypelysRouter
/// @notice The Hypelys app's on-chain entry point and its integrator account in the Eridanos registry
///         (integrator #1, mode A). Any other app can deploy its own instance and register the same way.
///
///         - `launch`: the caller is always the creator; the token salt is bound to the caller so nobody can
///           front-run a user's salt through the shared router; unspent dev-buy quote is returned to the user.
///         - `buy` / `sell`: exact-input swaps through the Uniswap v4 PoolManager with slippage and deadline.
///           No price limit is set, so swaps fill completely (the anti-sniper surcharge is computed on the
///           specified input — review finding R-2).
///         - The owner can only manage this router's own registry record (payout, signer, policy, profile,
///           activity, account move). There is no function that moves user funds or calls arbitrary targets.
contract HypelysRouter is IUnlockCallback, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    error CreatorMustBeCaller();
    error UnknownToken();
    error Expired();
    error Slippage(uint256 out, uint256 minOut);
    error WrongValue();
    error NotPoolManager();
    error NativeTransferFailed();

    event LaunchedVia(address indexed token, bytes32 indexed poolId, address indexed creator);
    event Swapped(address indexed token, address indexed trader, bool buy, uint256 amountIn, uint256 amountOut);

    struct SwapData {
        bytes32 poolId;
        bool buy;
        uint256 amountIn;
        address payer;
        address recipient;
    }

    LaunchCore public immutable core;
    IPoolManager public immutable poolManager;
    CurveHook public immutable hook;
    ProtocolConfig public immutable config;
    IntegratorRegistry public immutable registry;
    uint32 public immutable integratorId;

    constructor(
        address owner_,
        LaunchCore core_,
        string memory name,
        string memory uri,
        address signer,
        address payout,
        IntegratorRegistry.Policy memory policy
    ) Ownable(owner_) {
        core = core_;
        poolManager = core_.poolManager();
        hook = core_.hook();
        config = core_.config();
        registry = core_.registry();
        // This contract becomes the integrator account: launches it forwards are attributed to it (mode A).
        integratorId = registry.register(name, uri, signer, payout, policy);
    }

    /// @notice Receives dev-buy refunds from the hook and native swap outputs from the PoolManager.
    receive() external payable {}

    // ===================================================================================== launch

    function launch(LaunchCore.LaunchParams calldata p) external payable nonReentrant returns (address token, bytes32 poolId) {
        if (p.creator != msg.sender) revert CreatorMustBeCaller();
        (ProtocolConfig.PresetInfo memory preset,) = config.preset(p.presetId);
        address quote = preset.quote;

        uint256 before = quote == address(0) ? address(this).balance - msg.value : IERC20(quote).balanceOf(address(this));
        if (quote != address(0) && p.maxDevBuyQuote != 0) {
            IERC20(quote).safeTransferFrom(msg.sender, address(this), p.maxDevBuyQuote);
            IERC20(quote).forceApprove(address(core), p.maxDevBuyQuote);
        }

        LaunchCore.LaunchParams memory q = p;
        q.salt = userSalt(msg.sender, p.salt);
        (token, poolId) = core.launch{value: msg.value}(q);

        uint256 afterBal = quote == address(0) ? address(this).balance : IERC20(quote).balanceOf(address(this));
        if (afterBal > before) _pay(quote, msg.sender, afterBal - before);
        if (quote != address(0)) IERC20(quote).forceApprove(address(core), 0);
        emit LaunchedVia(token, poolId, msg.sender);
    }

    /// @notice Salt actually passed to the core for a user's salt (bind to the user: no cross-user collisions).
    function userSalt(address user, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(user, salt));
    }

    /// @notice Token address a launch by `user` through this router will get.
    function predictToken(address user, LaunchCore.LaunchParams calldata p) external view returns (address) {
        LaunchCore.LaunchParams memory q = p;
        q.salt = userSalt(user, p.salt);
        return core.predictToken(address(this), q);
    }

    // ===================================================================================== trading

    /// @notice Buy `token` with exactly `amountIn` of its quote (msg.value for native HYPE).
    function buy(address token, uint256 amountIn, uint256 minOut, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 out)
    {
        bytes32 poolId = _poolOf(token, deadline);
        (CurveHook.PoolInfo memory info,,) = hook.poolInfo(poolId);
        if (info.quote == address(0) ? msg.value != amountIn : msg.value != 0) revert WrongValue();
        uint256 owed;
        (out, owed) = _swap(SwapData(poolId, true, amountIn, msg.sender, msg.sender), minOut);
        // A buy larger than what is left on the curve fills partially: return the unused HYPE.
        if (info.quote == address(0) && owed < amountIn) _pay(address(0), msg.sender, amountIn - owed);
        emit Swapped(token, msg.sender, true, owed, out);
    }

    /// @notice Sell exactly `amountIn` of `token` for its quote. Requires an allowance to this router.
    function sell(address token, uint256 amountIn, uint256 minOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 out)
    {
        bytes32 poolId = _poolOf(token, deadline);
        uint256 owed;
        (out, owed) = _swap(SwapData(poolId, false, amountIn, msg.sender, msg.sender), minOut);
        emit Swapped(token, msg.sender, false, owed, out);
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        SwapData memory d = abi.decode(raw, (SwapData));
        (CurveHook.PoolInfo memory info, PoolKey memory key,) = hook.poolInfo(d.poolId);
        bool zeroForOne = d.buy ? !info.tokenIs0 : info.tokenIs0;
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(d.amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (Currency input, Currency output) = zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        (int128 inDelta, int128 outDelta) = zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        uint256 owed = uint256(uint128(-inDelta));
        uint256 out = uint256(uint128(outDelta));

        if (input.isAddressZero()) {
            poolManager.settle{value: owed}();
        } else {
            poolManager.sync(input);
            IERC20(Currency.unwrap(input)).safeTransferFrom(d.payer, address(poolManager), owed);
            poolManager.settle();
        }
        poolManager.take(output, d.recipient, out);
        return abi.encode(out, owed);
    }

    // ===================================================================================== registry record

    function setPayout(address payout) external onlyOwner {
        registry.setPayout(integratorId, payout);
    }

    function setSigner(address signer) external onlyOwner {
        registry.setSigner(integratorId, signer);
    }

    function setProfile(string calldata name, string calldata uri) external onlyOwner {
        registry.setProfile(integratorId, name, uri);
    }

    function setSelfActive(bool active) external onlyOwner {
        registry.setSelfActive(integratorId, active);
    }

    function queuePolicy(IntegratorRegistry.Policy calldata policy) external onlyOwner {
        registry.queuePolicy(integratorId, policy);
    }

    /// @notice Moves the integrator record to a new router version (the new account must accept).
    function transferIntegratorAccount(address newAccount) external onlyOwner {
        registry.transferAccount(integratorId, newAccount);
    }

    // ===================================================================================== internals

    function _poolOf(address token, uint256 deadline) internal view returns (bytes32 poolId) {
        if (block.timestamp > deadline) revert Expired();
        poolId = core.poolOf(token);
        if (poolId == bytes32(0)) revert UnknownToken();
    }

    function _swap(SwapData memory d, uint256 minOut) internal returns (uint256 out, uint256 owed) {
        (out, owed) = abi.decode(poolManager.unlock(abi.encode(d)), (uint256, uint256));
        if (out < minOut) revert Slippage(out, minOut);
    }

    function _pay(address currency, address to, uint256 amount) internal {
        if (currency == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(currency).safeTransfer(to, amount);
        }
    }
}
