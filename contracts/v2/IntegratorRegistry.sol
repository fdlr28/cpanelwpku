// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {EridanosConstants as C} from "./libraries/EridanosConstants.sol";

/// @title IntegratorRegistry
/// @notice On-chain identity of the apps (integrators) that launch tokens through Eridanos.
///
///         Attribution can never come from a self-declared field (the Doppler weakness, see
///         docs/desain/01-riset-model-acuan.md §1.1). A launch is attributed to integrator `id` only when:
///           mode A — the launch core's `msg.sender` is the integrator's registered `account`, or
///           mode B — the integrator's registered `signer` signed an EIP-712 `LaunchIntent` that names the
///                    core, the caller, the creator and the exact launch parameters, with a single-use nonce.
///         Payouts go to the `payout` address stored here, read at claim time.
contract IntegratorRegistry is Ownable2Step, EIP712 {
    /// @notice What an integrator imposes on launches made through it. Every field may only be equal to
    ///         or stricter than the protocol bounds in EridanosConstants.
    struct Policy {
        uint16 integratorBps; // share of the base fee taken from the creator's share, ≤ 3000
        uint16 maxAllocBps; // creator allocation cap, ≤ 2000
        uint16 maxDevBuyBps; // dev buy cap, ≤ 1000
        uint32 minCliff; // seconds, ≥ 0
        uint32 minDuration; // seconds, ≥ 0 (0 allows instant allocations)
        uint32 devBuyLock; // seconds the dev buy must vest; 0 = paid out directly
    }

    struct Integrator {
        address account;
        address pendingAccount;
        address signer;
        address payout;
        bool selfActive;
        bool suspended;
        bool approved;
        bool verified;
        uint64 pendingPolicyAt;
        Policy policy;
        Policy pendingPolicy;
        string name;
        string uri;
    }

    /// @notice Mode B authorisation, signed by the integrator's signer.
    struct LaunchIntent {
        uint32 integratorId;
        address core; // launch core that may consume it — binds the signature to one core version
        address caller; // must equal the core's msg.sender (checked by the core)
        address creator;
        bytes32 paramsHash; // hash of the launch parameters, excluding the signature
        uint256 nonce; // single use per integrator, any order
        uint64 deadline;
    }

    bytes32 public constant LAUNCH_INTENT_TYPEHASH = keccak256(
        "LaunchIntent(uint32 integratorId,address core,address caller,address creator,bytes32 paramsHash,uint256 nonce,uint64 deadline)"
    );

    uint256 public constant MAX_NAME_LENGTH = 64;
    uint256 public constant MAX_URI_LENGTH = 256;

    error UnknownIntegrator(uint32 id);
    error NotIntegratorAccount();
    error AccountAlreadyRegistered(address account);
    error NotPendingAccount();
    error ZeroAddress();
    error InvalidProfile();
    error InvalidPolicy();
    error RegistrationPaused();
    error NotGuardian();
    error NotCore();
    error WrongCore();
    error IntentExpired();
    error IntegratorCannotLaunch(uint32 id);
    error NonceAlreadyUsed();
    error InvalidSignature();

    event IntegratorRegistered(uint32 indexed id, address indexed account, address signer, address payout, bool approved);
    event AccountTransferStarted(uint32 indexed id, address indexed newAccount);
    event AccountTransferred(uint32 indexed id, address indexed oldAccount, address indexed newAccount);
    event SignerUpdated(uint32 indexed id, address signer);
    event PayoutUpdated(uint32 indexed id, address payout);
    event ProfileUpdated(uint32 indexed id, string name, string uri);
    event SelfActiveSet(uint32 indexed id, bool active);
    event PolicyQueued(uint32 indexed id, Policy policy, uint64 effectiveAt);
    event SuspendedSet(uint32 indexed id, bool suspended);
    event ApprovedSet(uint32 indexed id, bool approved);
    event VerifiedSet(uint32 indexed id, bool verified);
    event AllowlistEnabledSet(bool enabled);
    event CoreSet(address indexed core, bool authorized);
    event GuardianUpdated(address guardian);
    event RegistrationPausedSet(bool paused);
    event IntentConsumed(uint32 indexed id, uint256 indexed nonce, address indexed core, address caller, address creator);

    uint32 public integratorCount;
    mapping(uint32 id => Integrator) internal _integrators;
    mapping(address account => uint32 id) public idOfAccount;
    mapping(uint32 id => mapping(uint256 nonce => bool)) public nonceUsed;

    /// @notice When true, new registrations start unapproved and only approved integrators can be used.
    bool public allowlistEnabled;
    bool public registrationPaused;
    address public guardian;
    mapping(address core => bool) public isCore;

    constructor(address owner_, address guardian_) Ownable(owner_) EIP712("Eridanos", "1") {
        guardian = guardian_;
        emit GuardianUpdated(guardian_);
    }

    modifier onlyAccount(uint32 id) {
        if (id == 0 || id > integratorCount) revert UnknownIntegrator(id);
        if (_integrators[id].account != msg.sender) revert NotIntegratorAccount();
        _;
    }

    // =================================================================================== integrators

    /// @notice Registers `msg.sender` as a new integrator. The initial policy is effective immediately;
    ///         later changes wait POLICY_DELAY.
    function register(
        string calldata name,
        string calldata uri,
        address signer,
        address payout,
        Policy calldata policy
    ) external returns (uint32 id) {
        if (registrationPaused) revert RegistrationPaused();
        if (idOfAccount[msg.sender] != 0) revert AccountAlreadyRegistered(msg.sender);
        if (payout == address(0)) revert ZeroAddress();
        _validateProfile(name, uri);
        validatePolicy(policy);

        id = ++integratorCount;
        Integrator storage it = _integrators[id];
        it.account = msg.sender;
        it.signer = signer;
        it.payout = payout;
        it.selfActive = true;
        it.approved = !allowlistEnabled;
        it.policy = policy;
        it.name = name;
        it.uri = uri;
        idOfAccount[msg.sender] = id;

        emit IntegratorRegistered(id, msg.sender, signer, payout, it.approved);
        emit ProfileUpdated(id, name, uri);
        emit PolicyQueued(id, policy, uint64(block.timestamp));
    }

    /// @notice Step 1 of moving the integrator to a new account (e.g. a new router version).
    function transferAccount(uint32 id, address newAccount) external onlyAccount(id) {
        if (newAccount == address(0)) revert ZeroAddress();
        _integrators[id].pendingAccount = newAccount;
        emit AccountTransferStarted(id, newAccount);
    }

    /// @notice Step 2: the new account accepts.
    function acceptAccount(uint32 id) external {
        if (id == 0 || id > integratorCount) revert UnknownIntegrator(id);
        Integrator storage it = _integrators[id];
        if (msg.sender != it.pendingAccount) revert NotPendingAccount();
        if (idOfAccount[msg.sender] != 0) revert AccountAlreadyRegistered(msg.sender);
        address old = it.account;
        delete idOfAccount[old];
        idOfAccount[msg.sender] = id;
        it.account = msg.sender;
        it.pendingAccount = address(0);
        emit AccountTransferred(id, old, msg.sender);
    }

    /// @notice `address(0)` disables mode B for this integrator.
    function setSigner(uint32 id, address signer) external onlyAccount(id) {
        _integrators[id].signer = signer;
        emit SignerUpdated(id, signer);
    }

    function setPayout(uint32 id, address payout) external onlyAccount(id) {
        if (payout == address(0)) revert ZeroAddress();
        _integrators[id].payout = payout;
        emit PayoutUpdated(id, payout);
    }

    function setProfile(uint32 id, string calldata name, string calldata uri) external onlyAccount(id) {
        _validateProfile(name, uri);
        _integrators[id].name = name;
        _integrators[id].uri = uri;
        emit ProfileUpdated(id, name, uri);
    }

    /// @notice The integrator can stop (and resume) new launches being attributed to it.
    function setSelfActive(uint32 id, bool active) external onlyAccount(id) {
        _integrators[id].selfActive = active;
        emit SelfActiveSet(id, active);
    }

    /// @notice Queues a new policy. It applies to launches from `block.timestamp + POLICY_DELAY`; queueing
    ///         again replaces the pending policy and restarts the delay. Existing pools never change.
    function queuePolicy(uint32 id, Policy calldata policy) external onlyAccount(id) {
        validatePolicy(policy);
        Integrator storage it = _integrators[id];
        _materialize(it);
        it.pendingPolicy = policy;
        it.pendingPolicyAt = uint64(block.timestamp + C.POLICY_DELAY);
        emit PolicyQueued(id, policy, it.pendingPolicyAt);
    }

    // =================================================================================== owner / guardian

    function setAllowlistEnabled(bool enabled) external onlyOwner {
        allowlistEnabled = enabled;
        emit AllowlistEnabledSet(enabled);
    }

    function setApproved(uint32 id, bool approved) external onlyOwner {
        _requireExists(id);
        _integrators[id].approved = approved;
        emit ApprovedSet(id, approved);
    }

    function setVerified(uint32 id, bool verified) external onlyOwner {
        _requireExists(id);
        _integrators[id].verified = verified;
        emit VerifiedSet(id, verified);
    }

    /// @notice Stops new launches from being attributed to `id`. Pools that already launched keep paying.
    function setSuspended(uint32 id, bool suspended) external onlyOwner {
        _requireExists(id);
        _integrators[id].suspended = suspended;
        emit SuspendedSet(id, suspended);
    }

    function setCore(address core, bool authorized) external onlyOwner {
        if (core == address(0)) revert ZeroAddress();
        isCore[core] = authorized;
        emit CoreSet(core, authorized);
    }

    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianUpdated(guardian_);
    }

    /// @notice Guardian (no delay) can only pause registrations; unpausing goes through the owner (Timelock).
    function pauseRegistration() external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian();
        registrationPaused = true;
        emit RegistrationPausedSet(true);
    }

    function unpauseRegistration() external onlyOwner {
        registrationPaused = false;
        emit RegistrationPausedSet(false);
    }

    // =================================================================================== launch core

    /// @notice Mode B: verifies and consumes a signed intent. Only an authorised core can consume nonces,
    ///         so nobody can burn an integrator's nonces. The core must also check `intent.caller == msg.sender`
    ///         on its side and that `paramsHash` matches the parameters it is executing.
    function consumeIntent(LaunchIntent calldata intent, bytes calldata signature)
        external
        returns (Policy memory policy)
    {
        if (!isCore[msg.sender]) revert NotCore();
        if (intent.core != msg.sender) revert WrongCore();
        if (block.timestamp > intent.deadline) revert IntentExpired();
        uint32 id = intent.integratorId;
        if (!canLaunch(id)) revert IntegratorCannotLaunch(id);
        if (nonceUsed[id][intent.nonce]) revert NonceAlreadyUsed();

        address signer = _integrators[id].signer;
        if (signer == address(0) || !SignatureChecker.isValidSignatureNow(signer, hashIntent(intent), signature)) {
            revert InvalidSignature();
        }
        nonceUsed[id][intent.nonce] = true;
        emit IntentConsumed(id, intent.nonce, msg.sender, intent.caller, intent.creator);
        return policyOf(id);
    }

    // =================================================================================== views

    /// @notice True when launches may currently be attributed to `id`.
    function canLaunch(uint32 id) public view returns (bool) {
        if (id == 0 || id > integratorCount) return false;
        Integrator storage it = _integrators[id];
        return it.selfActive && !it.suspended && (!allowlistEnabled || it.approved);
    }

    /// @notice Mode A: integrator id whose account is `caller` (0 if none).
    function integratorOf(address caller) external view returns (uint32) {
        return idOfAccount[caller];
    }

    /// @notice The policy that applies to a launch made now.
    function policyOf(uint32 id) public view returns (Policy memory) {
        _requireExists(id);
        Integrator storage it = _integrators[id];
        if (it.pendingPolicyAt != 0 && block.timestamp >= it.pendingPolicyAt) return it.pendingPolicy;
        return it.policy;
    }

    function payoutOf(uint32 id) external view returns (address) {
        _requireExists(id);
        return _integrators[id].payout;
    }

    function getIntegrator(uint32 id) external view returns (Integrator memory) {
        _requireExists(id);
        return _integrators[id];
    }

    function hashIntent(LaunchIntent calldata intent) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    LAUNCH_INTENT_TYPEHASH,
                    intent.integratorId,
                    intent.core,
                    intent.caller,
                    intent.creator,
                    intent.paramsHash,
                    intent.nonce,
                    intent.deadline
                )
            )
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Reverts unless `policy` is within the protocol bounds.
    function validatePolicy(Policy calldata policy) public pure {
        if (
            policy.integratorBps > C.MAX_INTEGRATOR_BPS || policy.maxAllocBps > C.MAX_ALLOC_BPS
                || policy.maxDevBuyBps > C.MAX_DEVBUY_BPS || policy.minCliff > C.MAX_POLICY_LOCK
                || policy.minDuration > C.MAX_POLICY_LOCK || policy.devBuyLock > C.MAX_POLICY_LOCK
        ) revert InvalidPolicy();
    }

    // =================================================================================== internals

    /// @dev Moves an already-effective pending policy into `policy` before a new one is queued.
    function _materialize(Integrator storage it) internal {
        if (it.pendingPolicyAt != 0 && block.timestamp >= it.pendingPolicyAt) {
            it.policy = it.pendingPolicy;
        }
        it.pendingPolicyAt = 0;
    }

    function _validateProfile(string calldata name, string calldata uri) internal pure {
        uint256 n = bytes(name).length;
        if (n == 0 || n > MAX_NAME_LENGTH || bytes(uri).length > MAX_URI_LENGTH) revert InvalidProfile();
    }

    function _requireExists(uint32 id) internal view {
        if (id == 0 || id > integratorCount) revert UnknownIntegrator(id);
    }
}
