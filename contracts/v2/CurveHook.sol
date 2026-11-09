// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IVault} from "../vendor/infinity/src/interfaces/IVault.sol";
import {IHooks} from "../vendor/infinity/src/interfaces/IHooks.sol";
import {IPoolManager} from "../vendor/infinity/src/interfaces/IPoolManager.sol";
import {ILockCallback} from "../vendor/infinity/src/interfaces/ILockCallback.sol";
import {ICLPoolManager} from "../vendor/infinity/src/pool-cl/interfaces/ICLPoolManager.sol";
import {ICLHooks} from "../vendor/infinity/src/pool-cl/interfaces/ICLHooks.sol";
import {LPFeeLibrary} from "../vendor/infinity/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "../vendor/infinity/src/pool-cl/libraries/TickMath.sol";
import {PoolKey} from "../vendor/infinity/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "../vendor/infinity/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "../vendor/infinity/src/types/Currency.sol";
import {BalanceDelta} from "../vendor/infinity/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "../vendor/infinity/src/types/BeforeSwapDelta.sol";
import {EridanosConstants as C} from "./libraries/EridanosConstants.sol";
import {CurveHookFlags} from "./libraries/CurveHookFlags.sol";
import {CurveBand, CurveMath} from "./libraries/CurveMath.sol";

interface IFeeDistributorHook {
    function credit(bytes32 poolId, uint256 tokenAmount, uint256 quoteAmount) external;
    function creditSurcharge(address currency, uint256 amount) external;
}

/// @title CurveHook
/// @notice PancakeSwap Infinity CL hook, owner of every Eridanos LP position, and fee collector.
///
///  Pool    PoolKey{token/quote, fee = DYNAMIC_FEE_FLAG, parameters = hook bitmap + tickSpacing 200,
///          hooks = this, poolManager = the CL pool manager}. Only this contract can create such pools
///          (beforeInitialize) or add liquidity to them (beforeAddLiquidity); Infinity skips the hook when the
///          hook itself is the caller, which is how our own seeding passes.
///  Curve   The preset's bands are seeded single-sided with the pool's tokens. No code path ever removes
///          liquidity: `collect` pokes positions with a zero delta to harvest fees only.
///  Fees    base fee 1% for life (LP fee override, also stored for quoters), split by FeeDistributor.
///          During the first DECAY_SECONDS after launch (block.timestamp only — on Orbit, block.number is the
///          parent chain's) a surcharge brings the total to f(t) = 1% + 89% · (10 − t)/10. The surcharge is
///          taken from the swap's input via return deltas and held as vault claims:
///          in quote → 100% protocol; in token → burned (sent to 0x…dEaD). Never to creator or integrator.
///          The dev buy in the launch transaction is executed by this hook, so it skips the surcharge and
///          pays the stored 1% LP fee (decision D3c).
contract CurveHook is ICLHooks, ILockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;

    struct PoolInfo {
        address token;
        address quote; // address(0) = native HYPE
        bool tokenIs0;
        uint40 launchedAt;
    }

    struct BandTicks {
        int24 tickLower;
        int24 tickUpper;
    }

    struct SeedParams {
        address token;
        address quote;
        int24 startTick;
        uint256 poolTokens; // tokens transferred to this hook for the curve
        uint256 devBuyTokens; // exact tokens to buy in the launch tx (0 = none)
        uint256 maxDevBuyQuote; // quote available for the dev buy (msg.value or transferred ERC-20)
        address devBuyRecipient;
        address refundTo; // receives unspent dev-buy quote
    }

    uint8 private constant OP_SEED = 1;
    uint8 private constant OP_COLLECT = 2;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 private constant PIPS = 1_000_000;

    error NotPoolManager();
    error NotVault();
    error NotCore();
    error NotDeployer();
    error AlreadyBound();
    error ExternalPoolsNotAllowed();
    error ExternalLiquidityNotAllowed();
    error HookNotImplemented();
    error UnknownPool();
    error PoolAlreadySeeded();
    error InvalidBandLiquidity(uint256 index);
    error DevBuyShortfall(uint256 expected, uint256 received);
    error DevBuyTooExpensive(uint256 cost, uint256 max);
    error NativeTransferFailed();

    event PoolSeeded(bytes32 indexed poolId, address indexed token, address indexed quote, bool tokenIs0, uint256 poolTokens, uint256 dust);
    event DevBuy(bytes32 indexed poolId, address indexed recipient, uint256 tokens, uint256 quoteSpent);
    event SurchargeCharged(bytes32 indexed poolId, address indexed currency, uint256 amount, bool exactInput);
    event Collected(bytes32 indexed poolId, uint256 tokenFees, uint256 quoteFees);
    event SurchargeFlushed(address indexed currency, uint256 amount, bool burned);

    ICLPoolManager public immutable poolManager;
    IVault public immutable vault;
    address private immutable _deployer;
    address public core;
    IFeeDistributorHook public distributor;

    mapping(PoolId => PoolInfo) internal _pools;
    mapping(PoolId => BandTicks[]) internal _bands;
    mapping(PoolId => PoolKey) internal _keys;

    /// @param binder_ The account allowed to call `bind` once (core and distributor are deployed after this hook).
    constructor(ICLPoolManager poolManager_, address binder_) {
        poolManager = poolManager_;
        vault = poolManager_.vault();
        _deployer = binder_;
    }

    /// @notice One-time wiring (core and distributor need this hook's address, so they come after it).
    function bind(address core_, address distributor_) external {
        if (msg.sender != _deployer) revert NotDeployer();
        if (core != address(0)) revert AlreadyBound();
        core = core_;
        distributor = IFeeDistributorHook(distributor_);
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    /// @notice Native HYPE for the dev buy comes from the core; the vault never pays this contract natively
    ///         except as part of an operation started here.
    receive() external payable {}

    /// @inheritdoc IHooks
    function getHooksRegistrationBitmap() external pure returns (uint16) {
        return CurveHookFlags.BITMAP;
    }

    // ===================================================================================== launch

    /// @notice Creates and seeds the pool, then runs the optional dev buy. Called by LaunchCore only, after
    ///         it transferred `poolTokens` (and, for an ERC-20 quote, `maxDevBuyQuote`) to this contract.
    function seed(SeedParams calldata p, CurveBand[] calldata bands)
        external
        payable
        returns (bytes32 poolId, uint256 quoteSpent)
    {
        if (msg.sender != core) revert NotCore();
        bool tokenIs0 = p.token < p.quote; // native HYPE (address 0) always sorts first
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(tokenIs0 ? p.token : p.quote),
            currency1: Currency.wrap(tokenIs0 ? p.quote : p.token),
            hooks: IHooks(address(this)),
            poolManager: IPoolManager(address(poolManager)),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            parameters: CurveHookFlags.parameters()
        });
        PoolId id = key.toId();
        if (_pools[id].token != address(0)) revert PoolAlreadySeeded();

        _pools[id] = PoolInfo({token: p.token, quote: p.quote, tokenIs0: tokenIs0, launchedAt: uint40(block.timestamp)});
        _keys[id] = key;
        BandTicks[] storage stored = _bands[id];
        for (uint256 i; i < bands.length; ++i) {
            (int24 lo, int24 up) = CurveMath.bandTicks(tokenIs0, p.startTick, bands[i]);
            stored.push(BandTicks(lo, up));
        }

        poolManager.initialize(key, TickMath.getSqrtRatioAtTick(CurveMath.startPoolTick(tokenIs0, p.startTick, C.TICK_SPACING)));
        // Store the base fee: quoters read it, and our own dev buy (which skips beforeSwap) pays it.
        poolManager.updateDynamicLPFee(key, C.BASE_FEE);

        quoteSpent = abi.decode(vault.lock(abi.encode(OP_SEED, abi.encode(key, p, bands))), (uint256));

        // Rounding dust of the band amounts is burned rather than kept anywhere.
        uint256 dust = IERC20(p.token).balanceOf(address(this));
        if (dust != 0) IERC20(p.token).safeTransfer(DEAD, dust);

        uint256 unspent = p.maxDevBuyQuote - quoteSpent;
        if (unspent != 0) _pay(p.quote, p.refundTo, unspent);

        poolId = PoolId.unwrap(id);
        emit PoolSeeded(poolId, p.token, p.quote, tokenIs0, p.poolTokens - dust, dust);
        if (p.devBuyTokens != 0) emit DevBuy(poolId, p.devBuyRecipient, p.devBuyTokens, quoteSpent);
    }

    // ===================================================================================== fees

    /// @notice Harvests the base fee of `poolId` to the FeeDistributor and flushes surcharge claims
    ///         (quote → protocol, this pool's token → burned). Permissionless.
    function collect(bytes32 poolId) external returns (uint256 tokenFees, uint256 quoteFees) {
        PoolId id = PoolId.wrap(poolId);
        PoolInfo memory info = _pools[id];
        if (info.token == address(0)) revert UnknownPool();
        uint256 quoteSurcharge;
        (tokenFees, quoteFees, quoteSurcharge) =
            abi.decode(vault.lock(abi.encode(OP_COLLECT, abi.encode(id))), (uint256, uint256, uint256));
        distributor.credit(poolId, tokenFees, quoteFees);
        distributor.creditSurcharge(info.quote, quoteSurcharge);
        emit Collected(poolId, tokenFees, quoteFees);
    }

    /// @notice Total fee (base + surcharge) charged on a swap of pool `poolId` right now, in pips.
    function currentFee(bytes32 poolId) external view returns (uint24) {
        PoolInfo storage info = _pools[PoolId.wrap(poolId)];
        if (info.token == address(0)) revert UnknownPool();
        return _scheduleFee(info.launchedAt);
    }

    /// @notice Surcharge rate (pips of the swap's gross input) right now; 0 after the anti-sniper window.
    function surchargeRate(bytes32 poolId) external view returns (uint256) {
        PoolInfo storage info = _pools[PoolId.wrap(poolId)];
        if (info.token == address(0)) revert UnknownPool();
        return _surchargeRate(info.launchedAt);
    }

    // ===================================================================================== vault callback

    function lockAcquired(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != address(vault)) revert NotVault();
        (uint8 op, bytes memory data) = abi.decode(raw, (uint8, bytes));
        if (op == OP_SEED) {
            (PoolKey memory key, SeedParams memory p, CurveBand[] memory bands) =
                abi.decode(data, (PoolKey, SeedParams, CurveBand[]));
            return abi.encode(_seedCallback(key, p, bands));
        }
        return _collectCallback(abi.decode(data, (PoolId)));
    }

    // ===================================================================================== hook callbacks

    function beforeInitialize(address, PoolKey calldata, uint160) external view onlyPoolManager returns (bytes4) {
        // Reached only when someone other than this hook initialises a pool that names it.
        revert ExternalPoolsNotAllowed();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ICLPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        // Reached only for third-party liquidity: the pool is closed.
        revert ExternalLiquidityNotAllowed();
    }

    function beforeSwap(address, PoolKey calldata key, ICLPoolManager.SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        uint24 lpFee = C.BASE_FEE | LPFeeLibrary.OVERRIDE_FEE_FLAG;
        PoolId id = key.toId();
        uint256 f = _scheduleFee(_pools[id].launchedAt);
        if (f <= C.BASE_FEE || params.amountSpecified >= 0) {
            return (ICLHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, lpFee);
        }
        // Exact input X (the specified currency is the input). Total fee must be f·X, the LP fee is BASE on
        // what reaches the pool: s + BASE·(X − s) = f·X  ⇒  s = X·(f − BASE)/(1 − BASE).
        uint256 surcharge = (uint256(-params.amountSpecified) * (f - C.BASE_FEE)) / (PIPS - C.BASE_FEE);
        if (surcharge == 0) return (ICLHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, lpFee);
        Currency input = params.zeroForOne ? key.currency0 : key.currency1;
        vault.mint(address(this), input, surcharge);
        emit SurchargeCharged(PoolId.unwrap(id), Currency.unwrap(input), surcharge, true);
        return (ICLHooks.beforeSwap.selector, toBeforeSwapDelta(int128(int256(surcharge)), 0), lpFee);
    }

    function afterSwap(
        address,
        PoolKey calldata key,
        ICLPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external onlyPoolManager returns (bytes4, int128) {
        if (params.amountSpecified < 0) return (ICLHooks.afterSwap.selector, 0);
        PoolId id = key.toId();
        uint256 f = _scheduleFee(_pools[id].launchedAt);
        if (f <= C.BASE_FEE) return (ICLHooks.afterSwap.selector, 0);
        // Exact output: the unspecified currency is the input and A (what the pool took, LP fee included) is
        // only known now. Gross input T = A + s and total fee f·T = s + BASE·A  ⇒  s = A·(f − BASE)/(1 − f).
        int128 poolInput = params.zeroForOne ? delta.amount0() : delta.amount1();
        uint256 surcharge = (uint256(uint128(-poolInput)) * (f - C.BASE_FEE)) / (PIPS - f);
        if (surcharge == 0) return (ICLHooks.afterSwap.selector, 0);
        Currency input = params.zeroForOne ? key.currency0 : key.currency1;
        vault.mint(address(this), input, surcharge);
        emit SurchargeCharged(PoolId.unwrap(id), Currency.unwrap(input), surcharge, false);
        return (ICLHooks.afterSwap.selector, int128(int256(surcharge)));
    }

    // Callbacks this hook does not register (Infinity never calls them for our pools).
    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ICLPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ICLPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ICLPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    // ===================================================================================== internals

    function _seedCallback(PoolKey memory key, SeedParams memory p, CurveBand[] memory bands)
        internal
        returns (uint256 quoteSpent)
    {
        bool tokenIs0 = Currency.unwrap(key.currency0) == p.token;
        uint256 remaining = p.poolTokens;
        uint256 owed;
        for (uint256 i; i < bands.length; ++i) {
            uint256 amount = i == bands.length - 1 ? remaining : (p.poolTokens * bands[i].bps) / C.BPS;
            remaining -= amount;
            uint256 liquidity = CurveMath.bandLiquidity(tokenIs0, p.startTick, bands[i], amount);
            if (liquidity == 0) revert InvalidBandLiquidity(i);
            (int24 lo, int24 up) = CurveMath.bandTicks(tokenIs0, p.startTick, bands[i]);
            (BalanceDelta callerDelta,) = poolManager.modifyLiquidity(
                key,
                ICLPoolManager.ModifyLiquidityParams({tickLower: lo, tickUpper: up, liquidityDelta: int256(liquidity), salt: bytes32(0)}),
                ""
            );
            owed += uint256(uint128(-(tokenIs0 ? callerDelta.amount0() : callerDelta.amount1())));
        }
        _settle(Currency.wrap(p.token), owed);

        if (p.devBuyTokens != 0) {
            bool zeroForOne = !tokenIs0; // pay quote, receive token
            BalanceDelta d = poolManager.swap(
                key,
                ICLPoolManager.SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: int256(p.devBuyTokens), // exact output
                    sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
                }),
                ""
            );
            (int128 tokenDelta, int128 quoteDelta) = tokenIs0 ? (d.amount0(), d.amount1()) : (d.amount1(), d.amount0());
            uint256 received = uint256(uint128(tokenDelta));
            if (received != p.devBuyTokens) revert DevBuyShortfall(p.devBuyTokens, received);
            quoteSpent = uint256(uint128(-quoteDelta));
            if (quoteSpent > p.maxDevBuyQuote) revert DevBuyTooExpensive(quoteSpent, p.maxDevBuyQuote);
            _settle(Currency.wrap(p.quote), quoteSpent);
            vault.take(Currency.wrap(p.token), p.devBuyRecipient, received);
        }
    }

    function _collectCallback(PoolId id) internal returns (bytes memory) {
        PoolKey memory key = _keys[id];
        PoolInfo memory info = _pools[id];
        BandTicks[] storage bands = _bands[id];
        int256 fees0;
        int256 fees1;
        for (uint256 i; i < bands.length; ++i) {
            (BalanceDelta d,) = poolManager.modifyLiquidity(
                key,
                ICLPoolManager.ModifyLiquidityParams({
                    tickLower: bands[i].tickLower,
                    tickUpper: bands[i].tickUpper,
                    liquidityDelta: 0,
                    salt: bytes32(0)
                }),
                ""
            );
            fees0 += d.amount0();
            fees1 += d.amount1();
        }
        (uint256 tokenFees, uint256 quoteFees) =
            info.tokenIs0 ? (uint256(fees0), uint256(fees1)) : (uint256(fees1), uint256(fees0));
        address dist = address(distributor);
        if (tokenFees != 0) vault.take(Currency.wrap(info.token), dist, tokenFees);
        if (quoteFees != 0) vault.take(Currency.wrap(info.quote), dist, quoteFees);

        // Surcharge claims: this pool's token → burn; quote (shared by all pools) → protocol.
        uint256 tokenSurcharge = _redeemClaims(Currency.wrap(info.token), DEAD);
        if (tokenSurcharge != 0) emit SurchargeFlushed(info.token, tokenSurcharge, true);
        uint256 quoteSurcharge = _redeemClaims(Currency.wrap(info.quote), dist);
        if (quoteSurcharge != 0) emit SurchargeFlushed(info.quote, quoteSurcharge, false);
        return abi.encode(tokenFees, quoteFees, quoteSurcharge);
    }

    function _redeemClaims(Currency currency, address to) internal returns (uint256 amount) {
        amount = vault.balanceOf(address(this), currency);
        if (amount == 0) return 0;
        vault.burn(address(this), currency, amount);
        vault.take(currency, to, amount);
    }

    function _settle(Currency currency, uint256 amount) internal {
        if (amount == 0) return;
        if (currency.isNative()) {
            vault.settle{value: amount}();
        } else {
            vault.sync(currency);
            IERC20(Currency.unwrap(currency)).safeTransfer(address(vault), amount);
            vault.settle();
        }
    }

    function _pay(address currency, address to, uint256 amount) internal {
        if (currency == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(currency).safeTransfer(to, amount);
        }
    }

    /// @dev f(t) = BASE + (START − BASE) · (DECAY − t) / DECAY for t < DECAY, else BASE (pips).
    function _scheduleFee(uint256 launchedAt) internal view returns (uint24) {
        uint256 elapsed = block.timestamp - launchedAt;
        if (elapsed >= C.DECAY_SECONDS) return C.BASE_FEE;
        return uint24(C.BASE_FEE + ((C.START_FEE - C.BASE_FEE) * (C.DECAY_SECONDS - elapsed)) / C.DECAY_SECONDS);
    }

    /// @dev Surcharge share of the gross input (pips, rounded down; for display — swaps use exact formulas).
    function _surchargeRate(uint256 launchedAt) internal view returns (uint256) {
        if (launchedAt == 0) return 0;
        uint256 f = _scheduleFee(launchedAt);
        if (f <= C.BASE_FEE) return 0;
        return ((f - C.BASE_FEE) * PIPS) / (PIPS - C.BASE_FEE);
    }

    // ===================================================================================== views

    function poolInfo(bytes32 poolId) external view returns (PoolInfo memory info, PoolKey memory key, BandTicks[] memory bands) {
        PoolId id = PoolId.wrap(poolId);
        info = _pools[id];
        if (info.token == address(0)) revert UnknownPool();
        return (info, _keys[id], _bands[id]);
    }

    /// @notice Current sqrt price and tick of the pool.
    function spot(bytes32 poolId) external view returns (uint160 sqrtPriceX96, int24 tick) {
        (sqrtPriceX96, tick,,) = poolManager.getSlot0(PoolId.wrap(poolId));
    }

    /// @notice Current liquidity of band `index` (never decreases).
    function bandLiquidity(bytes32 poolId, uint256 index) external view returns (uint128 liquidity) {
        PoolId id = PoolId.wrap(poolId);
        BandTicks storage b = _bands[id][index];
        liquidity = poolManager.getLiquidity(id, address(this), b.tickLower, b.tickUpper, bytes32(0));
    }
}
