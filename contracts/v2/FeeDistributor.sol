// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EridanosConstants as C} from "./libraries/EridanosConstants.sol";

interface IRegistryPayout {
    function payoutOf(uint32 id) external view returns (address);
}

interface IConfigTreasury {
    function treasury() external view returns (address);
}

/// @title FeeDistributor
/// @notice Splits the base trading fee of every Eridanos pool, with shares fixed at launch
///         (docs/desain/02-desain-arsitektur.md §6, decision D2):
///           protocol   = 20%                     (constant, every case)
///           integrator = integratorBps (≤ 30%)   (0 when the launch had no integrator)
///           creator    = the rest (≥ 50%)        (also receives rounding dust)
///         The anti-sniper surcharge never enters this split: in quote it goes 100% to the protocol, in the
///         token it is burned by CurveHook.
///
///         Balances are pull-based. Anyone may trigger a claim; funds only ever go to the role's recipient:
///         the pool's current creator, the integrator's payout address in the registry, or the treasury.
contract FeeDistributor is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    struct PoolTerms {
        address token;
        address quote; // address(0) = native HYPE
        address creator;
        address pendingCreator;
        uint32 integratorId; // 0 = no integrator
        uint16 integratorBps;
    }

    error NotDeployer();
    error AlreadyBound();
    error NotCore();
    error NotHook();
    error UnknownPool();
    error PoolExists();
    error InvalidTerms();
    error NotCreator();
    error NotPendingCreator();
    error NothingToClaim();
    error NativeTransferFailed();

    event PoolRegistered(bytes32 indexed poolId, address token, address quote, address creator, uint32 integratorId, uint16 integratorBps);
    event FeesSplit(
        bytes32 indexed poolId,
        address indexed currency,
        uint256 amount,
        uint256 toProtocol,
        uint256 toIntegrator,
        uint256 toCreator
    );
    event SurchargeReceived(address indexed currency, uint256 amount);
    event CreatorClaimed(bytes32 indexed poolId, address indexed to, address indexed currency, uint256 amount);
    event IntegratorClaimed(uint32 indexed integratorId, address indexed to, address indexed currency, uint256 amount);
    event ProtocolClaimed(address indexed to, address indexed currency, uint256 amount);
    event CreatorTransferStarted(bytes32 indexed poolId, address indexed next);
    event CreatorTransferred(bytes32 indexed poolId, address indexed previous, address indexed next);

    IRegistryPayout public immutable registry;
    IConfigTreasury public immutable config;
    address private immutable _deployer;
    address public core;
    address public hook;

    mapping(bytes32 poolId => PoolTerms) internal _terms;
    mapping(bytes32 poolId => mapping(address currency => uint256)) public creatorOwed;
    mapping(uint32 integratorId => mapping(address currency => uint256)) public integratorOwed;
    mapping(address currency => uint256) public protocolOwed;

    constructor(IRegistryPayout registry_, IConfigTreasury config_) {
        registry = registry_;
        config = config_;
        _deployer = msg.sender;
    }

    /// @notice One-time wiring to the launch core and hook (they reference each other's addresses).
    function bind(address core_, address hook_) external {
        if (msg.sender != _deployer) revert NotDeployer();
        if (core != address(0)) revert AlreadyBound();
        core = core_;
        hook = hook_;
    }

    /// @notice Native HYPE fees arrive from the PoolManager via CurveHook.collect.
    receive() external payable {}

    // ===================================================================================== core / hook

    function registerPool(
        bytes32 poolId,
        address token,
        address quote,
        address creator,
        uint32 integratorId,
        uint16 integratorBps
    ) external {
        if (msg.sender != core) revert NotCore();
        if (_terms[poolId].token != address(0)) revert PoolExists();
        if (
            token == address(0) || creator == address(0) || integratorBps > C.MAX_INTEGRATOR_BPS
                || (integratorId == 0 && integratorBps != 0)
        ) revert InvalidTerms();
        _terms[poolId] = PoolTerms({
            token: token,
            quote: quote,
            creator: creator,
            pendingCreator: address(0),
            integratorId: integratorId,
            integratorBps: integratorBps
        });
        emit PoolRegistered(poolId, token, quote, creator, integratorId, integratorBps);
    }

    /// @notice Base fees just transferred here by the hook for `poolId`.
    function credit(bytes32 poolId, uint256 tokenAmount, uint256 quoteAmount) external {
        if (msg.sender != hook) revert NotHook();
        PoolTerms storage t = _terms[poolId];
        if (t.token == address(0)) revert UnknownPool();
        _split(poolId, t, t.token, tokenAmount);
        _split(poolId, t, t.quote, quoteAmount);
    }

    /// @notice Anti-sniper surcharge in a quote currency: 100% protocol.
    function creditSurcharge(address currency, uint256 amount) external {
        if (msg.sender != hook) revert NotHook();
        if (amount == 0) return;
        protocolOwed[currency] += amount;
        emit SurchargeReceived(currency, amount);
    }

    function _split(bytes32 poolId, PoolTerms storage t, address currency, uint256 amount) internal {
        if (amount == 0) return;
        uint256 toProtocol = (amount * C.PROTOCOL_BPS) / C.BPS;
        uint256 toIntegrator = (amount * t.integratorBps) / C.BPS;
        uint256 toCreator = amount - toProtocol - toIntegrator;
        protocolOwed[currency] += toProtocol;
        if (toIntegrator != 0) integratorOwed[t.integratorId][currency] += toIntegrator;
        creatorOwed[poolId][currency] += toCreator;
        emit FeesSplit(poolId, currency, amount, toProtocol, toIntegrator, toCreator);
    }

    // ===================================================================================== claims

    /// @notice Pays the pool's creator both currencies. Anyone may call.
    function claimCreator(bytes32 poolId) external nonReentrant {
        PoolTerms storage t = _terms[poolId];
        if (t.token == address(0)) revert UnknownPool();
        uint256 a = creatorOwed[poolId][t.token];
        uint256 b = creatorOwed[poolId][t.quote];
        if (a == 0 && b == 0) revert NothingToClaim();
        address to = t.creator;
        creatorOwed[poolId][t.token] = 0;
        creatorOwed[poolId][t.quote] = 0;
        if (a != 0) {
            _pay(t.token, to, a);
            emit CreatorClaimed(poolId, to, t.token, a);
        }
        if (b != 0) {
            _pay(t.quote, to, b);
            emit CreatorClaimed(poolId, to, t.quote, b);
        }
    }

    /// @notice Pays an integrator's balance in `currency` to its payout address in the registry.
    function claimIntegrator(uint32 integratorId, address currency) external nonReentrant {
        uint256 amount = integratorOwed[integratorId][currency];
        if (amount == 0) revert NothingToClaim();
        integratorOwed[integratorId][currency] = 0;
        address to = registry.payoutOf(integratorId);
        _pay(currency, to, amount);
        emit IntegratorClaimed(integratorId, to, currency, amount);
    }

    /// @notice Pays the protocol balance in `currency` to the treasury in ProtocolConfig.
    function claimProtocol(address currency) external nonReentrant {
        uint256 amount = protocolOwed[currency];
        if (amount == 0) revert NothingToClaim();
        protocolOwed[currency] = 0;
        address to = config.treasury();
        _pay(currency, to, amount);
        emit ProtocolClaimed(to, currency, amount);
    }

    // ===================================================================================== creator role

    /// @notice The creator proposes a successor; `address(0)` cancels. Nobody else (no admin) can move it.
    function transferCreator(bytes32 poolId, address next) external {
        PoolTerms storage t = _terms[poolId];
        if (msg.sender != t.creator) revert NotCreator();
        t.pendingCreator = next;
        emit CreatorTransferStarted(poolId, next);
    }

    function acceptCreator(bytes32 poolId) external {
        PoolTerms storage t = _terms[poolId];
        if (msg.sender != t.pendingCreator || msg.sender == address(0)) revert NotPendingCreator();
        emit CreatorTransferred(poolId, t.creator, msg.sender);
        t.creator = msg.sender;
        t.pendingCreator = address(0);
    }

    // ===================================================================================== views

    function feeTerms(bytes32 poolId)
        external
        view
        returns (PoolTerms memory terms, uint256 protocolBps, uint256 integratorBps, uint256 creatorBps)
    {
        terms = _terms[poolId];
        if (terms.token == address(0)) revert UnknownPool();
        protocolBps = C.PROTOCOL_BPS;
        integratorBps = terms.integratorBps;
        creatorBps = C.BPS - C.PROTOCOL_BPS - terms.integratorBps;
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
