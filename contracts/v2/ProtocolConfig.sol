// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {Pool} from "@uniswap/v4-core/src/libraries/Pool.sol";
import {EridanosConstants as C} from "./libraries/EridanosConstants.sol";

/// @title ProtocolConfig
/// @notice Settings that the launch core snapshots at launch time: allowed quote currencies, curve presets
///         and the protocol treasury. Owned by the Timelock. Nothing here can touch a pool that already
///         launched: the core copies what it needs into the pool's immutable terms.
///
/// Curve presets (docs/desain/02-desain-arsitektur.md §5.3)
///   A preset is a start tick and a list of bands {offsetLower, offsetUpper, bps} in *canonical* tick space:
///   the token is priced in the quote and the price rises with the offset. When the token sorts as
///   currency0 a band maps to pool ticks [start + lower, start + upper]; when it sorts as currency1 the band
///   is mirrored to [-(start + upper), -(start + lower)]. Presets are append-only: once added they can be
///   disabled for future launches but never edited, so every launch's curve stays reproducible.
contract ProtocolConfig is Ownable2Step {
    struct CurveBand {
        int24 offsetLower;
        int24 offsetUpper;
        uint16 bps;
    }

    struct PresetInfo {
        address quote;
        int24 startTick;
        int24 curveTop; // last band's offsetUpper
        bool enabled;
        uint8 bandCount;
    }

    error ZeroAddress();
    error QuoteNotAllowed(address quote);
    error InvalidCurve(uint256 bandIndex);
    error InvalidStartTick();
    error LiquidityTooHigh(uint256 bandIndex);
    error UnknownPreset(uint16 presetId);

    event TreasuryUpdated(address treasury);
    event GuardianUpdated(address guardian);
    event QuoteSet(address indexed quote, bool allowed);
    event CurvePresetAdded(uint16 indexed presetId, address indexed quote, int24 startTick, CurveBand[] bands);
    event CurvePresetEnabled(uint16 indexed presetId, bool enabled);

    /// @notice Receives the protocol's 20% share and the anti-sniper surcharge paid in quote.
    address public treasury;
    /// @notice May pause new launches instantly (see LaunchCore); cannot unpause or change anything else.
    address public guardian;

    mapping(address quote => bool) public isQuoteAllowed;

    uint16 public presetCount;
    mapping(uint16 presetId => PresetInfo) internal _presets;
    mapping(uint16 presetId => CurveBand[]) internal _bands;

    constructor(address owner_, address treasury_, address guardian_) Ownable(owner_) {
        _setTreasury(treasury_);
        guardian = guardian_;
        emit GuardianUpdated(guardian_);
    }

    // ------------------------------------------------------------------------------------- owner

    function setTreasury(address treasury_) external onlyOwner {
        _setTreasury(treasury_);
    }

    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianUpdated(guardian_);
    }

    /// @notice Allow or disallow a quote currency for future launches. `address(0)` is native HYPE.
    /// @dev Only plain ERC-20s that move exact amounts belong here (no fee-on-transfer, no rebasing).
    function setQuote(address quote, bool allowed) external onlyOwner {
        isQuoteAllowed[quote] = allowed;
        emit QuoteSet(quote, allowed);
    }

    /// @notice Registers a new, immutable curve preset for an allowed quote.
    function addCurvePreset(address quote, int24 startTick, CurveBand[] calldata bands)
        external
        onlyOwner
        returns (uint16 presetId)
    {
        if (!isQuoteAllowed[quote]) revert QuoteNotAllowed(quote);
        int24 top = validateCurve(startTick, bands);

        presetId = ++presetCount;
        _presets[presetId] = PresetInfo({
            quote: quote,
            startTick: startTick,
            curveTop: top,
            enabled: true,
            bandCount: uint8(bands.length)
        });
        CurveBand[] storage stored = _bands[presetId];
        for (uint256 i; i < bands.length; ++i) {
            stored.push(bands[i]);
        }
        emit CurvePresetAdded(presetId, quote, startTick, bands);
    }

    function setCurvePresetEnabled(uint16 presetId, bool enabled) external onlyOwner {
        if (presetId == 0 || presetId > presetCount) revert UnknownPreset(presetId);
        _presets[presetId].enabled = enabled;
        emit CurvePresetEnabled(presetId, enabled);
    }

    // ------------------------------------------------------------------------------------- views

    function preset(uint16 presetId) external view returns (PresetInfo memory info, CurveBand[] memory bands) {
        if (presetId == 0 || presetId > presetCount) revert UnknownPreset(presetId);
        return (_presets[presetId], _bands[presetId]);
    }

    /// @notice True when `presetId` exists, is enabled and its quote is still allowed.
    function isPresetUsable(uint16 presetId) external view returns (bool) {
        if (presetId == 0 || presetId > presetCount) return false;
        PresetInfo storage p = _presets[presetId];
        return p.enabled && isQuoteAllowed[p.quote];
    }

    /// @notice Validates a curve against the pool rules and returns its top offset.
    /// @dev Checks, in order: 1..MAX_CURVE_BANDS bands; every edge a multiple of TICK_SPACING; bands sorted,
    ///      non-overlapping and non-empty; bps > 0 and summing to 10 000; the whole curve (plus the one
    ///      spacing the pool starts below it) inside the usable tick range; and, for both token orderings
    ///      and the maximum token amount a pool can receive (the full supply), a positive liquidity per band
    ///      that stays under the PoolManager's per-tick cap, adjacent bands included.
    function validateCurve(int24 startTick, CurveBand[] calldata bands) public pure returns (int24 top) {
        uint256 n = bands.length;
        if (n == 0 || n > C.MAX_CURVE_BANDS) revert InvalidCurve(n);
        int24 spacing = C.TICK_SPACING;

        uint256 bpsSum;
        for (uint256 i; i < n; ++i) {
            CurveBand calldata b = bands[i];
            if (
                b.offsetLower < top || b.offsetUpper <= b.offsetLower || b.bps == 0 || b.offsetLower % spacing != 0
                    || b.offsetUpper % spacing != 0
            ) revert InvalidCurve(i);
            top = b.offsetUpper;
            bpsSum += b.bps;
        }
        if (bpsSum != C.BPS) revert InvalidCurve(n);

        int256 maxUsable = TickMath.maxUsableTick(spacing);
        if (
            startTick % spacing != 0 || int256(startTick) - spacing < -maxUsable
                || int256(startTick) + top > maxUsable
        ) revert InvalidStartTick();

        _checkLiquidity(startTick, bands);
    }

    /// @dev Per-band liquidity check for both token orderings at the maximum pool amount (full supply).
    function _checkLiquidity(int24 startTick, CurveBand[] calldata bands) internal pure {
        uint128 maxLiquidity = Pool.tickSpacingToMaxLiquidityPerTick(C.TICK_SPACING);
        uint256 prev0;
        uint256 prev1;
        int24 prevUpper;
        for (uint256 i; i < bands.length; ++i) {
            CurveBand calldata b = bands[i];
            uint256 amount = (C.TOTAL_SUPPLY * b.bps) / C.BPS;
            uint256 l0 = bandLiquidity(true, startTick, b, amount);
            uint256 l1 = bandLiquidity(false, startTick, b, amount);
            bool adjacent = i > 0 && b.offsetLower == prevUpper;
            if (l0 == 0 || l1 == 0) revert LiquidityTooHigh(i);
            if (adjacent && (l0 + prev0 > maxLiquidity || l1 + prev1 > maxLiquidity)) revert LiquidityTooHigh(i);
            if (l0 > maxLiquidity || l1 > maxLiquidity) revert LiquidityTooHigh(i);
            (prev0, prev1, prevUpper) = (l0, l1, b.offsetUpper);
        }
    }

    /// @notice Pool-space ticks of a band for the given token ordering.
    function bandTicks(bool tokenIs0, int24 startTick, CurveBand memory b)
        public
        pure
        returns (int24 tickLower, int24 tickUpper)
    {
        (tickLower, tickUpper) = (startTick + b.offsetLower, startTick + b.offsetUpper);
        if (!tokenIs0) (tickLower, tickUpper) = (-tickUpper, -tickLower);
    }

    /// @notice Liquidity that places `amount` tokens single-sided in the band (same math as v4 periphery's
    ///         LiquidityAmounts, written out to avoid a periphery dependency). Returns 0 on overflow so the
    ///         caller rejects the curve instead of truncating.
    function bandLiquidity(bool tokenIs0, int24 startTick, CurveBand memory b, uint256 amount)
        public
        pure
        returns (uint256 liquidity)
    {
        (int24 lo, int24 up) = bandTicks(tokenIs0, startTick, b);
        uint256 sqrtA = TickMath.getSqrtPriceAtTick(lo);
        uint256 sqrtB = TickMath.getSqrtPriceAtTick(up);
        if (tokenIs0) {
            // amount0 = L · (sqrtB − sqrtA) · Q96 / (sqrtA · sqrtB)
            uint256 intermediate = FullMath.mulDiv(sqrtA, sqrtB, 1 << 96);
            liquidity = FullMath.mulDiv(amount, intermediate, sqrtB - sqrtA);
        } else {
            // amount1 = L · (sqrtB − sqrtA) / Q96
            liquidity = FullMath.mulDiv(amount, 1 << 96, sqrtB - sqrtA);
        }
        if (liquidity > type(uint128).max) liquidity = 0;
    }

    function _setTreasury(address treasury_) internal {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }
}
