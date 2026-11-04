// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {EridanosConstants as C} from "./libraries/EridanosConstants.sol";
import {CurveBand} from "./libraries/CurveMath.sol";
import {EridanosToken} from "./EridanosToken.sol";
import {ProtocolConfig} from "./ProtocolConfig.sol";
import {IntegratorRegistry} from "./IntegratorRegistry.sol";
import {VestingVault} from "./VestingVault.sol";
import {CurveHook} from "./CurveHook.sol";
import {FeeDistributor} from "./FeeDistributor.sol";

/// @title LaunchCore
/// @notice The single, open launch gateway of the Eridanos protocol (docs/desain/02-desain-arsitektur.md).
///
///  Attribution (never a self-declared field):
///    `launch`        — mode A if msg.sender is a registered integrator account, otherwise mode C (none);
///    `launchSigned`  — mode B: the integrator's signer authorised exactly these parameters for this caller.
///  Supply: 1e27 minted to this contract, then fully distributed in the same transaction:
///    creator allocations (≤ policy, ≤ 20%) → VestingVault (instant when duration = 0),
///    the rest → CurveHook, which seeds the curve; the optional dev buy (≤ policy, ≤ 10%) is bought from the
///    pool at the 1% base fee. The transaction reverts if any token is left here.
contract LaunchCore is Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint16 public constant VERSION = 1;
    uint256 public constant MAX_NAME_LENGTH = 32;
    uint256 public constant MAX_SYMBOL_LENGTH = 12;
    uint256 public constant MAX_URI_LENGTH = 512;

    struct Allocation {
        address recipient;
        uint16 bps;
    }

    struct LaunchParams {
        string name;
        string symbol;
        string metadataURI;
        bytes32 salt; // token address = CREATE2(keccak(msg.sender, salt)), so nobody can front-run a salt
        address creator;
        uint16 presetId; // curve + quote currency
        Allocation[] allocations; // ≤ 3 recipients, Σ bps ≤ policy.maxAllocBps (≤ 2000)
        uint32 cliff;
        uint32 duration; // 0 = instant allocation (allowed by decision D4, disclosed in the event)
        uint256 devBuyTokens; // exact tokens to buy at launch; ≤ policy.maxDevBuyBps of supply (≤ 10%)
        uint256 maxDevBuyQuote; // quote sent for the dev buy; unspent part is refunded to msg.sender
    }

    /// @notice Everything an observer needs to judge a launch, emitted once.
    struct LaunchRecord {
        bytes32 poolId;
        address creator;
        address caller;
        uint8 attribution; // 0 none, 1 caller (mode A), 2 signed (mode B)
        address quote;
        uint16 presetId;
        uint16 protocolBps;
        uint16 integratorBps;
        uint16 creatorBps;
        uint16 allocBps;
        uint32 cliff;
        uint32 duration;
        bool instantAllocation;
        uint256 devBuyTokens;
        uint256 devBuyQuoteSpent;
        uint32 devBuyLock;
        uint256 poolTokens;
    }

    error Paused();
    error NotGuardian();
    error InvalidParams();
    error PresetNotUsable(uint16 presetId);
    error IntegratorCannotLaunch(uint32 id);
    error AllocationNotAllowed();
    error DevBuyNotAllowed();
    error WrongFunds();
    error IntentMismatch();
    error TokensLeftBehind(uint256 amount);

    event Launched(uint256 indexed launchId, address indexed token, uint32 indexed integratorId, LaunchRecord record, uint16 coreVersion);
    event AllocationVested(uint256 indexed launchId, address indexed recipient, uint256 scheduleId, uint256 amount);
    event PausedSet(bool paused);

    IPoolManager public immutable poolManager;
    ProtocolConfig public immutable config;
    IntegratorRegistry public immutable registry;
    VestingVault public immutable vault;
    CurveHook public immutable hook;
    FeeDistributor public immutable distributor;

    bool public paused;
    uint256 public launchCount;
    mapping(address token => bytes32 poolId) public poolOf;

    constructor(
        address owner_,
        IPoolManager poolManager_,
        ProtocolConfig config_,
        IntegratorRegistry registry_,
        VestingVault vault_,
        CurveHook hook_,
        FeeDistributor distributor_
    ) Ownable(owner_) {
        poolManager = poolManager_;
        config = config_;
        registry = registry_;
        vault = vault_;
        hook = hook_;
        distributor = distributor_;
    }

    // ===================================================================================== admin

    /// @notice Guardian (instant) or owner can stop new launches. Swaps, fee collection, claims and vesting
    ///         are never affected.
    function pause() external {
        if (msg.sender != config.guardian() && msg.sender != owner()) revert NotGuardian();
        paused = true;
        emit PausedSet(true);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit PausedSet(false);
    }

    // ===================================================================================== launch

    /// @notice Mode A (caller is a registered integrator account) or mode C (no integrator).
    function launch(LaunchParams calldata p) external payable nonReentrant returns (address token, bytes32 poolId) {
        uint32 id = registry.integratorOf(msg.sender);
        IntegratorRegistry.Policy memory policy;
        uint8 attribution;
        if (id != 0) {
            if (!registry.canLaunch(id)) revert IntegratorCannotLaunch(id);
            policy = registry.policyOf(id);
            attribution = 1;
        } else {
            policy = defaultPolicy();
        }
        return _launch(p, id, policy, attribution);
    }

    /// @notice Mode B: a user launches directly with an integrator's EIP-712 authorisation.
    function launchSigned(LaunchParams calldata p, IntegratorRegistry.LaunchIntent calldata intent, bytes calldata signature)
        external
        payable
        nonReentrant
        returns (address token, bytes32 poolId)
    {
        if (intent.caller != msg.sender || intent.creator != p.creator || intent.paramsHash != hashParams(p)) {
            revert IntentMismatch();
        }
        IntegratorRegistry.Policy memory policy = registry.consumeIntent(intent, signature);
        return _launch(p, intent.integratorId, policy, 2);
    }

    // ===================================================================================== views

    /// @notice Hash that mode-B signers sign over (as LaunchIntent.paramsHash).
    function hashParams(LaunchParams calldata p) public pure returns (bytes32) {
        return keccak256(abi.encode(p));
    }

    /// @notice Bounds that apply when a launch has no integrator: the protocol limits themselves.
    function defaultPolicy() public pure returns (IntegratorRegistry.Policy memory) {
        return IntegratorRegistry.Policy({
            integratorBps: 0,
            maxAllocBps: uint16(C.MAX_ALLOC_BPS),
            maxDevBuyBps: uint16(C.MAX_DEVBUY_BPS),
            minCliff: 0,
            minDuration: 0,
            devBuyLock: 0
        });
    }

    /// @notice Address the token of a launch by `caller` with `salt` and metadata will have.
    function predictToken(address caller, LaunchParams calldata p) external view returns (address) {
        bytes32 initHash = keccak256(
            abi.encodePacked(type(EridanosToken).creationCode, abi.encode(p.name, p.symbol, p.metadataURI, address(this)))
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), _tokenSalt(caller, p.salt), initHash)))));
    }

    // ===================================================================================== internals

    function _launch(LaunchParams calldata p, uint32 integratorId, IntegratorRegistry.Policy memory policy, uint8 attribution)
        internal
        returns (address token, bytes32 poolId)
    {
        if (paused) revert Paused();
        _validateMetadata(p);
        if (!config.isPresetUsable(p.presetId)) revert PresetNotUsable(p.presetId);
        (ProtocolConfig.PresetInfo memory preset, CurveBand[] memory bands) = config.preset(p.presetId);
        uint256 allocBps = _validateAllocations(p, policy);
        _validateDevBuy(p, policy, preset.quote);

        token = address(
            new EridanosToken{salt: _tokenSalt(msg.sender, p.salt)}(p.name, p.symbol, p.metadataURI, address(this))
        );
        uint256 launchId = ++launchCount;

        _vestAllocations(launchId, token, p);

        LaunchRecord memory r;
        r.quote = preset.quote;
        r.poolTokens = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(address(hook), r.poolTokens);

        (r.poolId, r.devBuyQuoteSpent) = _seed(token, preset, bands, p, policy.devBuyLock, r.poolTokens);
        if (policy.devBuyLock != 0 && p.devBuyTokens != 0) {
            IERC20(token).forceApprove(address(vault), p.devBuyTokens);
            vault.createSchedule(token, p.creator, p.devBuyTokens, policy.devBuyLock, policy.devBuyLock);
        }

        uint256 left = IERC20(token).balanceOf(address(this));
        if (left != 0) revert TokensLeftBehind(left);

        distributor.registerPool(r.poolId, token, preset.quote, p.creator, integratorId, policy.integratorBps);
        poolOf[token] = r.poolId;
        poolId = r.poolId;

        r.creator = p.creator;
        r.caller = msg.sender;
        r.attribution = attribution;
        r.presetId = p.presetId;
        r.protocolBps = uint16(C.PROTOCOL_BPS);
        r.integratorBps = policy.integratorBps;
        r.creatorBps = uint16(C.BPS - C.PROTOCOL_BPS - policy.integratorBps);
        r.allocBps = uint16(allocBps);
        r.cliff = p.cliff;
        r.duration = p.duration;
        r.instantAllocation = allocBps != 0 && p.duration == 0;
        r.devBuyTokens = p.devBuyTokens;
        r.devBuyLock = p.devBuyTokens != 0 ? policy.devBuyLock : 0;
        emit Launched(launchId, token, integratorId, r, VERSION);
    }

    function _seed(
        address token,
        ProtocolConfig.PresetInfo memory preset,
        CurveBand[] memory bands,
        LaunchParams calldata p,
        uint32 devBuyLock,
        uint256 poolTokens
    ) internal returns (bytes32 poolId, uint256 spent) {
        uint256 value;
        if (p.maxDevBuyQuote != 0) {
            if (preset.quote == address(0)) value = p.maxDevBuyQuote;
            else IERC20(preset.quote).safeTransferFrom(msg.sender, address(hook), p.maxDevBuyQuote);
        }
        CurveHook.SeedParams memory s = CurveHook.SeedParams({
            token: token,
            quote: preset.quote,
            startTick: preset.startTick,
            poolTokens: poolTokens,
            devBuyTokens: p.devBuyTokens,
            maxDevBuyQuote: p.maxDevBuyQuote,
            devBuyRecipient: devBuyLock != 0 ? address(this) : p.creator,
            refundTo: msg.sender
        });
        return hook.seed{value: value}(s, bands);
    }

    function _vestAllocations(uint256 launchId, address token, LaunchParams calldata p) internal {
        uint256 n = p.allocations.length;
        if (n == 0) return;
        IERC20(token).forceApprove(address(vault), C.TOTAL_SUPPLY);
        for (uint256 i; i < n; ++i) {
            uint256 amount = (C.TOTAL_SUPPLY * p.allocations[i].bps) / C.BPS;
            uint256 scheduleId = vault.createSchedule(token, p.allocations[i].recipient, amount, p.cliff, p.duration);
            emit AllocationVested(launchId, p.allocations[i].recipient, scheduleId, amount);
        }
        IERC20(token).forceApprove(address(vault), 0);
    }

    function _validateMetadata(LaunchParams calldata p) internal pure {
        uint256 nameLen = bytes(p.name).length;
        uint256 symLen = bytes(p.symbol).length;
        if (
            p.creator == address(0) || nameLen == 0 || nameLen > MAX_NAME_LENGTH || symLen == 0
                || symLen > MAX_SYMBOL_LENGTH || bytes(p.metadataURI).length > MAX_URI_LENGTH
        ) revert InvalidParams();
    }

    function _validateAllocations(LaunchParams calldata p, IntegratorRegistry.Policy memory policy)
        internal
        pure
        returns (uint256 total)
    {
        uint256 n = p.allocations.length;
        if (n > C.MAX_ALLOC_RECIPIENTS) revert AllocationNotAllowed();
        for (uint256 i; i < n; ++i) {
            if (p.allocations[i].recipient == address(0) || p.allocations[i].bps == 0) revert AllocationNotAllowed();
            total += p.allocations[i].bps;
        }
        if (total > policy.maxAllocBps || total > C.MAX_ALLOC_BPS) revert AllocationNotAllowed();
        if (n == 0) {
            if (p.cliff != 0 || p.duration != 0) revert AllocationNotAllowed();
            return 0;
        }
        if (p.cliff > p.duration || p.cliff < policy.minCliff || p.duration < policy.minDuration) {
            revert AllocationNotAllowed();
        }
    }

    function _validateDevBuy(LaunchParams calldata p, IntegratorRegistry.Policy memory policy, address quote)
        internal
        view
    {
        uint256 cap = (C.TOTAL_SUPPLY * policy.maxDevBuyBps) / C.BPS;
        if (p.devBuyTokens > cap || p.devBuyTokens > (C.TOTAL_SUPPLY * C.MAX_DEVBUY_BPS) / C.BPS) {
            revert DevBuyNotAllowed();
        }
        if (p.devBuyTokens == 0 && p.maxDevBuyQuote != 0) revert DevBuyNotAllowed();
        uint256 expectedValue = quote == address(0) ? p.maxDevBuyQuote : 0;
        if (msg.value != expectedValue) revert WrongFunds();
    }

    function _tokenSalt(address caller, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(caller, salt));
    }
}
