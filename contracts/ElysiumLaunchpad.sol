// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {LaunchToken} from "./LaunchToken.sol";
import {IUniswapV2Factory, IUniswapV2Pair, IWrappedNative} from "./interfaces/IUniswapV2.sol";

/// @title ElysiumLaunchpad
/// @notice Fair-launch token launchpad for Elysium (HYPE as native gas token).
///
///  Lifecycle of a launch:
///   1. `createToken` deploys a fixed-supply LaunchToken. The launchpad holds the whole supply.
///   2. Users `buy` / `sell` against a constant-product bonding curve with virtual reserves
///      (x * y = k, priced in native HYPE). A trading fee is split between creator and protocol.
///   3. When `curveSupply` tokens have been sold, the curve closes and the raised HYPE plus the
///      matching amount of tokens are deposited into a Uniswap-V2-compatible pool at the same
///      final price. LP tokens are sent to the dead address (liquidity locked forever) and
///      any unused tokens are burned.
///
/// @dev Only `block.timestamp` is used for time. On Arbitrum Orbit chains (such as Elysium)
///      `block.number` returns the parent-chain block number, so it is deliberately avoided.
contract ElysiumLaunchpad is Ownable2Step, ReentrancyGuard {
    // ---------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------

    struct CurveConfig {
        uint256 totalSupply; // tokens minted per launch (18 decimals)
        uint256 curveSupply; // tokens sold on the bonding curve before graduation
        uint256 virtualNative; // initial virtual HYPE reserve
        uint256 virtualToken; // initial virtual token reserve
    }

    struct Pool {
        address creator;
        uint64 createdAt;
        bool graduated;
        address pair;
        uint256 virtualNative; // current virtual HYPE reserve
        uint256 virtualToken; // current virtual token reserve
        uint256 realNative; // HYPE actually held for this pool
        uint256 tokensSold; // tokens currently in circulation from the curve
        uint256 curveSupply; // snapshot of CurveConfig.curveSupply at creation
        uint256 initialVirtualNative; // snapshot, for UIs / analytics
    }

    // ---------------------------------------------------------------------------------------
    // Errors & events
    // ---------------------------------------------------------------------------------------

    error InvalidConfig();
    error InvalidAmount();
    error InvalidMetadata();
    error UnknownToken();
    error AlreadyGraduated();
    error Paused();
    error Slippage();
    error InsufficientFee();
    error NativeTransferFailed();
    error NothingToClaim();

    event TokenCreated(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        string metadataURI,
        address pair,
        uint256 virtualNative,
        uint256 virtualToken,
        uint256 curveSupply
    );

    event Trade(
        address indexed token,
        address indexed trader,
        bool isBuy,
        uint256 nativeAmount, // gross HYPE paid (buy) or net HYPE received (sell)
        uint256 tokenAmount,
        uint256 fee,
        uint256 virtualNative,
        uint256 virtualToken,
        uint256 timestamp
    );

    event Graduated(
        address indexed token,
        address indexed pair,
        uint256 nativeLiquidity,
        uint256 tokenLiquidity,
        uint256 tokensBurned,
        uint256 graduationFee,
        uint256 lpMinted
    );

    event FeesUpdated(uint256 tradeFeeBps, uint256 creatorShareBps, uint256 graduationFeeBps, uint256 creationFee);
    event CurveConfigUpdated(uint256 totalSupply, uint256 curveSupply, uint256 virtualNative, uint256 virtualToken);
    event FeeRecipientUpdated(address feeRecipient);
    event PausedSet(bool paused);
    event CreatorFeesClaimed(address indexed creator, uint256 amount);
    event ProtocolFeesClaimed(address indexed to, uint256 amount);

    // ---------------------------------------------------------------------------------------
    // Constants & storage
    // ---------------------------------------------------------------------------------------

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_TRADE_FEE_BPS = 500; // 5%
    uint256 public constant MAX_GRADUATION_FEE_BPS = 1_000; // 10%
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    uint256 public constant MAX_NAME_LENGTH = 32;
    uint256 public constant MAX_SYMBOL_LENGTH = 12;
    uint256 public constant MAX_URI_LENGTH = 1024;

    IUniswapV2Factory public immutable dexFactory;
    address public immutable wrappedNative;

    CurveConfig public curveConfig;

    uint256 public tradeFeeBps; // fee on every curve trade, in bps of the HYPE amount
    uint256 public creatorShareBps; // share of the trade fee that goes to the token creator
    uint256 public graduationFeeBps; // fee taken from raised HYPE at graduation
    uint256 public creationFee; // flat HYPE fee to create a token

    address public feeRecipient;
    bool public paused; // blocks createToken and buy; selling is always allowed

    uint256 public protocolFeesAccrued;
    mapping(address creator => uint256) public creatorFeesAccrued;

    mapping(address token => Pool) internal _pools;
    address[] public allTokens;

    // ---------------------------------------------------------------------------------------
    // Constructor & admin
    // ---------------------------------------------------------------------------------------

    constructor(
        address owner_,
        address dexFactory_,
        address wrappedNative_,
        address feeRecipient_,
        CurveConfig memory curveConfig_
    ) Ownable(owner_) {
        if (dexFactory_ == address(0) || wrappedNative_ == address(0) || feeRecipient_ == address(0)) {
            revert InvalidConfig();
        }
        dexFactory = IUniswapV2Factory(dexFactory_);
        wrappedNative = wrappedNative_;
        feeRecipient = feeRecipient_;

        _setCurveConfig(curveConfig_);
        _setFees(100, 2_500, 0, 0); // 1% trade fee, 25% of it to the creator (Ascend-like default)
    }

    function setCurveConfig(CurveConfig calldata cfg) external onlyOwner {
        _setCurveConfig(cfg);
    }

    function setFees(uint256 tradeFeeBps_, uint256 creatorShareBps_, uint256 graduationFeeBps_, uint256 creationFee_)
        external
        onlyOwner
    {
        _setFees(tradeFeeBps_, creatorShareBps_, graduationFeeBps_, creationFee_);
    }

    function setFeeRecipient(address feeRecipient_) external onlyOwner {
        if (feeRecipient_ == address(0)) revert InvalidConfig();
        feeRecipient = feeRecipient_;
        emit FeeRecipientUpdated(feeRecipient_);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function _setCurveConfig(CurveConfig memory cfg) internal {
        if (
            cfg.totalSupply == 0 || cfg.curveSupply == 0 || cfg.curveSupply >= cfg.totalSupply
                || cfg.virtualNative == 0 || cfg.virtualToken <= cfg.curveSupply
        ) revert InvalidConfig();
        // Final curve price must be reachable by the tokens left for the LP, otherwise
        // graduation would list below the curve price. remaining >= vT_end * raised / vN_end.
        uint256 vTEnd = cfg.virtualToken - cfg.curveSupply;
        uint256 vNEnd = Math.mulDiv(cfg.virtualNative, cfg.virtualToken, vTEnd, Math.Rounding.Ceil);
        uint256 raised = vNEnd - cfg.virtualNative;
        if (Math.mulDiv(raised, vTEnd, vNEnd) > cfg.totalSupply - cfg.curveSupply) revert InvalidConfig();
        curveConfig = cfg;
        emit CurveConfigUpdated(cfg.totalSupply, cfg.curveSupply, cfg.virtualNative, cfg.virtualToken);
    }

    function _setFees(uint256 tradeFeeBps_, uint256 creatorShareBps_, uint256 graduationFeeBps_, uint256 creationFee_)
        internal
    {
        if (tradeFeeBps_ > MAX_TRADE_FEE_BPS || creatorShareBps_ > BPS || graduationFeeBps_ > MAX_GRADUATION_FEE_BPS) {
            revert InvalidConfig();
        }
        tradeFeeBps = tradeFeeBps_;
        creatorShareBps = creatorShareBps_;
        graduationFeeBps = graduationFeeBps_;
        creationFee = creationFee_;
        emit FeesUpdated(tradeFeeBps_, creatorShareBps_, graduationFeeBps_, creationFee_);
    }

    // ---------------------------------------------------------------------------------------
    // Launch
    // ---------------------------------------------------------------------------------------

    /// @notice Creates a new token on the bonding curve.
    /// @param metadataURI URI (ipfs://, https://, or data:) of a JSON with image/description/socials.
    /// @param minTokensOut Slippage guard for the optional creator buy (msg.value - creationFee).
    function createToken(string calldata name, string calldata symbol, string calldata metadataURI, uint256 minTokensOut)
        external
        payable
        nonReentrant
        returns (address token)
    {
        if (paused) revert Paused();
        uint256 nameLen = bytes(name).length;
        uint256 symbolLen = bytes(symbol).length;
        if (
            nameLen == 0 || nameLen > MAX_NAME_LENGTH || symbolLen == 0 || symbolLen > MAX_SYMBOL_LENGTH
                || bytes(metadataURI).length > MAX_URI_LENGTH
        ) revert InvalidMetadata();
        if (msg.value < creationFee) revert InsufficientFee();

        CurveConfig memory cfg = curveConfig;

        LaunchToken t = new LaunchToken(name, symbol, metadataURI, msg.sender, cfg.totalSupply);
        token = address(t);

        // The pair may already exist if someone front-ran the creation with the predicted address.
        // That is harmless: tokens cannot be sent to it before graduation.
        address pair = dexFactory.getPair(token, wrappedNative);
        if (pair == address(0)) pair = dexFactory.createPair(token, wrappedNative);
        t.setPair(pair);

        _pools[token] = Pool({
            creator: msg.sender,
            createdAt: uint64(block.timestamp),
            graduated: false,
            pair: pair,
            virtualNative: cfg.virtualNative,
            virtualToken: cfg.virtualToken,
            realNative: 0,
            tokensSold: 0,
            curveSupply: cfg.curveSupply,
            initialVirtualNative: cfg.virtualNative
        });
        allTokens.push(token);

        protocolFeesAccrued += creationFee;

        emit TokenCreated(
            token, msg.sender, name, symbol, metadataURI, pair, cfg.virtualNative, cfg.virtualToken, cfg.curveSupply
        );

        uint256 initialBuy = msg.value - creationFee;
        if (initialBuy > 0) {
            _buy(token, initialBuy, minTokensOut);
        } else if (minTokensOut > 0) {
            revert Slippage();
        }
    }

    // ---------------------------------------------------------------------------------------
    // Trading
    // ---------------------------------------------------------------------------------------

    /// @notice Buys tokens with native HYPE. Any HYPE beyond what is needed to finish the curve
    ///         is refunded, and the purchase that completes the curve triggers graduation.
    function buy(address token, uint256 minTokensOut) external payable nonReentrant returns (uint256 tokensOut) {
        if (paused) revert Paused();
        if (msg.value == 0) revert InvalidAmount();
        tokensOut = _buy(token, msg.value, minTokensOut);
    }

    /// @notice Sells tokens back to the curve for native HYPE. No approval needed.
    function sell(address token, uint256 tokenAmount, uint256 minNativeOut)
        external
        nonReentrant
        returns (uint256 nativeOut)
    {
        Pool storage p = _pools[token];
        if (p.creator == address(0)) revert UnknownToken();
        if (p.graduated) revert AlreadyGraduated();
        if (tokenAmount == 0) revert InvalidAmount();

        uint256 grossOut = Math.mulDiv(p.virtualNative, tokenAmount, p.virtualToken + tokenAmount);
        if (grossOut > p.realNative) grossOut = p.realNative; // defensive; unreachable by the k-invariant
        uint256 fee = Math.mulDiv(grossOut, tradeFeeBps, BPS);
        nativeOut = grossOut - fee;
        if (nativeOut < minNativeOut || nativeOut == 0) revert Slippage();

        p.virtualToken += tokenAmount;
        p.virtualNative -= grossOut;
        p.realNative -= grossOut;
        p.tokensSold -= tokenAmount;

        LaunchToken(token).transferFrom(msg.sender, address(this), tokenAmount);
        _accrueFee(p.creator, fee);

        emit Trade(token, msg.sender, false, nativeOut, tokenAmount, fee, p.virtualNative, p.virtualToken, block.timestamp);

        _sendNative(msg.sender, nativeOut);
    }

    function _buy(address token, uint256 grossIn, uint256 minTokensOut) internal returns (uint256 tokensOut) {
        Pool storage p = _pools[token];
        if (p.creator == address(0)) revert UnknownToken();
        if (p.graduated) revert AlreadyGraduated();

        (uint256 out, uint256 fee, uint256 netIn, uint256 spent, uint256 refund) = _computeBuy(p, grossIn);
        tokensOut = out;
        if (tokensOut == 0 || tokensOut < minTokensOut) revert Slippage();

        p.virtualNative += netIn;
        p.virtualToken -= tokensOut;
        p.realNative += netIn;
        p.tokensSold += tokensOut;

        _accrueFee(p.creator, fee);
        LaunchToken(token).transfer(msg.sender, tokensOut);

        emit Trade(token, msg.sender, true, spent, tokensOut, fee, p.virtualNative, p.virtualToken, block.timestamp);

        if (p.tokensSold == p.curveSupply) _graduate(token, p);
        if (refund > 0) _sendNative(msg.sender, refund);
    }

    /// @dev Pure curve math for a buy of `grossIn` HYPE (fee included).
    ///      If the buy would exceed the remaining curve supply it is capped and the excess refunded.
    function _computeBuy(Pool storage p, uint256 grossIn)
        internal
        view
        returns (uint256 tokensOut, uint256 fee, uint256 netIn, uint256 spent, uint256 refund)
    {
        uint256 vN = p.virtualNative;
        uint256 vT = p.virtualToken;
        fee = Math.mulDiv(grossIn, tradeFeeBps, BPS);
        netIn = grossIn - fee;
        spent = grossIn;
        tokensOut = Math.mulDiv(vT, netIn, vN + netIn);

        uint256 remaining = p.curveSupply - p.tokensSold;
        if (tokensOut >= remaining) {
            tokensOut = remaining;
            uint256 neededNet = Math.mulDiv(vN, vT, vT - remaining, Math.Rounding.Ceil) - vN;
            uint256 neededGross = Math.mulDiv(neededNet, BPS, BPS - tradeFeeBps, Math.Rounding.Ceil);
            // Only shrink the purchase; a rounding overshoot keeps the original (sufficient) amounts.
            if (neededGross <= grossIn && neededNet <= netIn) {
                netIn = neededNet;
                spent = neededGross;
                fee = neededGross - neededNet;
                refund = grossIn - neededGross;
            }
        }
    }

    // ---------------------------------------------------------------------------------------
    // Graduation
    // ---------------------------------------------------------------------------------------

    function _graduate(address token, Pool storage p) internal {
        p.graduated = true;

        uint256 raised = p.realNative;
        uint256 gradFee = Math.mulDiv(raised, graduationFeeBps, BPS);
        uint256 nativeLiquidity = raised - gradFee;
        p.realNative = 0;
        protocolFeesAccrued += gradFee;

        // List at the final curve price: tokens = HYPE * vT / vN.
        LaunchToken t = LaunchToken(token);
        uint256 available = t.balanceOf(address(this));
        uint256 tokenLiquidity = Math.mulDiv(nativeLiquidity, p.virtualToken, p.virtualNative);
        if (tokenLiquidity > available) tokenLiquidity = available;
        uint256 toBurn = available - tokenLiquidity;

        // Seed the pair directly and mint, instead of going through a router. A router's
        // addLiquidity would revert if someone had donated WHYPE to the pair and synced it;
        // minting directly simply absorbs such a donation into the pool.
        address pair = p.pair;
        IWrappedNative(wrappedNative).deposit{value: nativeLiquidity}();
        IWrappedNative(wrappedNative).transfer(pair, nativeLiquidity);
        t.transfer(pair, tokenLiquidity);
        t.markGraduated();
        if (toBurn > 0) t.burn(toBurn);

        uint256 lp = IUniswapV2Pair(pair).mint(DEAD);

        emit Graduated(token, pair, nativeLiquidity, tokenLiquidity, toBurn, gradFee, lp);
    }

    // ---------------------------------------------------------------------------------------
    // Fees
    // ---------------------------------------------------------------------------------------

    function _accrueFee(address creator, uint256 fee) internal {
        if (fee == 0) return;
        uint256 creatorPart = Math.mulDiv(fee, creatorShareBps, BPS);
        creatorFeesAccrued[creator] += creatorPart;
        protocolFeesAccrued += fee - creatorPart;
    }

    function claimCreatorFees() external nonReentrant {
        uint256 amount = creatorFeesAccrued[msg.sender];
        if (amount == 0) revert NothingToClaim();
        creatorFeesAccrued[msg.sender] = 0;
        emit CreatorFeesClaimed(msg.sender, amount);
        _sendNative(msg.sender, amount);
    }

    function claimProtocolFees() external nonReentrant {
        uint256 amount = protocolFeesAccrued;
        if (amount == 0) revert NothingToClaim();
        protocolFeesAccrued = 0;
        address to = feeRecipient;
        emit ProtocolFeesClaimed(to, amount);
        _sendNative(to, amount);
    }

    function _sendNative(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
    }

    // ---------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------

    function getPool(address token) external view returns (Pool memory) {
        return _pools[token];
    }

    function allTokensLength() external view returns (uint256) {
        return allTokens.length;
    }

    /// @notice Returns up to `limit` token addresses starting at `offset`, newest last.
    function getTokens(uint256 offset, uint256 limit) external view returns (address[] memory tokens) {
        uint256 len = allTokens.length;
        if (offset >= len) return new address[](0);
        uint256 end = offset + limit > len ? len : offset + limit;
        tokens = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            tokens[i - offset] = allTokens[i];
        }
    }

    /// @notice Spot price in HYPE per whole token, scaled by 1e18.
    function currentPrice(address token) external view returns (uint256) {
        Pool storage p = _pools[token];
        if (p.creator == address(0)) revert UnknownToken();
        return Math.mulDiv(p.virtualNative, 1e18, p.virtualToken);
    }

    /// @notice Curve progress towards graduation, in bps (10_000 = graduated).
    function progressBps(address token) external view returns (uint256) {
        Pool storage p = _pools[token];
        if (p.creator == address(0)) revert UnknownToken();
        if (p.graduated) return BPS;
        return Math.mulDiv(p.tokensSold, BPS, p.curveSupply);
    }

    /// @notice Quote for `buy`: tokens received, fee, HYPE actually spent and refunded.
    function quoteBuy(address token, uint256 grossIn)
        external
        view
        returns (uint256 tokensOut, uint256 fee, uint256 spent, uint256 refund)
    {
        Pool storage p = _pools[token];
        if (p.creator == address(0)) revert UnknownToken();
        if (p.graduated) return (0, 0, 0, grossIn);
        (tokensOut, fee,, spent, refund) = _computeBuy(p, grossIn);
    }

    /// @notice Quote for `sell`: HYPE received after fees, and the fee.
    function quoteSell(address token, uint256 tokenAmount) external view returns (uint256 nativeOut, uint256 fee) {
        Pool storage p = _pools[token];
        if (p.creator == address(0)) revert UnknownToken();
        if (p.graduated || tokenAmount == 0) return (0, 0);
        uint256 grossOut = Math.mulDiv(p.virtualNative, tokenAmount, p.virtualToken + tokenAmount);
        if (grossOut > p.realNative) grossOut = p.realNative;
        fee = Math.mulDiv(grossOut, tradeFeeBps, BPS);
        nativeOut = grossOut - fee;
    }

    /// @notice HYPE (gross, incl. fee) needed to buy out the rest of the curve and graduate.
    function nativeToGraduate(address token) external view returns (uint256) {
        Pool storage p = _pools[token];
        if (p.creator == address(0)) revert UnknownToken();
        if (p.graduated) return 0;
        uint256 remaining = p.curveSupply - p.tokensSold;
        uint256 newVT = p.virtualToken - remaining;
        uint256 newVN = Math.mulDiv(p.virtualNative, p.virtualToken, newVT, Math.Rounding.Ceil);
        return Math.mulDiv(newVN - p.virtualNative, BPS, BPS - tradeFeeBps, Math.Rounding.Ceil);
    }
}
