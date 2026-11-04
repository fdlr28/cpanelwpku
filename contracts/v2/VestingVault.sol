// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title VestingVault
/// @notice Holds creator allocations of Eridanos launches. One vault serves every token.
///
///         Schedule semantics (same as the common "cliff inside the vesting window" model):
///           vested(t) = 0                                   if t < start + cliff
///                     = total · (t − start) / duration      if start + cliff ≤ t < start + duration
///                     = total                             if t ≥ start + duration
///         `duration == 0` (allowed by protocol decision D4) is an instant allocation: the vault pays the
///         beneficiary inside `createSchedule`, and the schedule still exists on-chain as a record.
///
///         No owner, no admin, no way to change a beneficiary or schedule, no way to take tokens out other
///         than `release` to the fixed beneficiary.
contract VestingVault is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    struct Schedule {
        address token;
        address beneficiary;
        address depositor;
        uint128 total;
        uint128 released;
        uint64 start;
        uint32 cliff;
        uint32 duration;
    }

    error InvalidSchedule();
    error UnsupportedToken();
    error UnknownSchedule();
    error NothingToRelease();

    event ScheduleCreated(
        uint256 indexed id,
        address indexed token,
        address indexed beneficiary,
        address depositor,
        uint256 amount,
        uint64 start,
        uint32 cliff,
        uint32 duration
    );
    event Released(uint256 indexed id, address indexed beneficiary, uint256 amount);

    uint256 public scheduleCount;
    mapping(uint256 id => Schedule) internal _schedules;

    /// @notice Pulls `amount` of `token` from the caller and locks it for `beneficiary`.
    function createSchedule(address token, address beneficiary, uint256 amount, uint32 cliff, uint32 duration)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (token == address(0) || beneficiary == address(0) || amount == 0 || amount > type(uint128).max) {
            revert InvalidSchedule();
        }
        if (cliff > duration) revert InvalidSchedule();

        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        // Exact-amount tokens only (no fee-on-transfer / rebasing): vested sums must stay exact.
        if (IERC20(token).balanceOf(address(this)) - balanceBefore != amount) revert UnsupportedToken();

        id = ++scheduleCount;
        _schedules[id] = Schedule({
            token: token,
            beneficiary: beneficiary,
            depositor: msg.sender,
            total: uint128(amount),
            released: 0,
            start: uint64(block.timestamp),
            cliff: cliff,
            duration: duration
        });
        emit ScheduleCreated(id, token, beneficiary, msg.sender, amount, uint64(block.timestamp), cliff, duration);

        if (duration == 0) _release(id);
    }

    /// @notice Sends everything currently releasable to the schedule's beneficiary. Anyone may call.
    function release(uint256 id) external nonReentrant returns (uint256 amount) {
        if (id == 0 || id > scheduleCount) revert UnknownSchedule();
        amount = _release(id);
    }

    function _release(uint256 id) internal returns (uint256 amount) {
        Schedule storage s = _schedules[id];
        amount = _vested(s, block.timestamp) - s.released;
        if (amount == 0) revert NothingToRelease();
        s.released += uint128(amount);
        IERC20(s.token).safeTransfer(s.beneficiary, amount);
        emit Released(id, s.beneficiary, amount);
    }

    function _vested(Schedule storage s, uint256 t) internal view returns (uint256) {
        uint256 start = s.start;
        if (t >= start + s.duration) return s.total;
        if (t < start + s.cliff) return 0;
        return (uint256(s.total) * (t - start)) / s.duration;
    }

    // ------------------------------------------------------------------------------------------ views

    function getSchedule(uint256 id) external view returns (Schedule memory) {
        if (id == 0 || id > scheduleCount) revert UnknownSchedule();
        return _schedules[id];
    }

    function vestedAmount(uint256 id, uint256 timestamp) external view returns (uint256) {
        if (id == 0 || id > scheduleCount) revert UnknownSchedule();
        return _vested(_schedules[id], timestamp);
    }

    function releasable(uint256 id) external view returns (uint256) {
        if (id == 0 || id > scheduleCount) revert UnknownSchedule();
        Schedule storage s = _schedules[id];
        return _vested(s, block.timestamp) - s.released;
    }
}
