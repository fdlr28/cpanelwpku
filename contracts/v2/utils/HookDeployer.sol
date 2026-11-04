// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title HookDeployer
/// @notice Minimal CREATE2 deployer used to place v4 hooks at a mined address. It has no owner and no
///         state: anyone can deploy any init code, but the resulting address is a pure function of
///         (this deployer, salt, init code), so a hook's address and permission bits are reproducible
///         from public data.
contract HookDeployer {
    error DeploymentFailed();

    event Deployed(address indexed deployed, bytes32 indexed salt, bytes32 initCodeHash);

    function deploy(bytes32 salt, bytes calldata initCode) external payable returns (address deployed) {
        bytes memory code = initCode;
        assembly ("memory-safe") {
            deployed := create2(callvalue(), add(code, 0x20), mload(code), salt)
        }
        if (deployed == address(0)) revert DeploymentFailed();
        emit Deployed(deployed, salt, keccak256(initCode));
    }

    function computeAddress(bytes32 salt, bytes32 initCodeHash) external view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
    }
}
