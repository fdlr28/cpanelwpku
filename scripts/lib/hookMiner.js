// Mines a CREATE2 salt so that a Uniswap v4 hook lands on an address whose low 14 bits equal the
// permission flags it registers (v4 reads hook permissions from the address).
const { ethers } = require("ethers");

const ALL_HOOK_MASK = (1n << 14n) - 1n;

// Must match contracts/v2/libraries/CurveHookFlags.sol
const FLAG = {
  BEFORE_INITIALIZE: 1n << 13n,
  BEFORE_ADD_LIQUIDITY: 1n << 11n,
  BEFORE_SWAP: 1n << 7n,
  AFTER_SWAP: 1n << 6n,
  BEFORE_SWAP_RETURNS_DELTA: 1n << 3n,
  AFTER_SWAP_RETURNS_DELTA: 1n << 2n,
};
const CURVE_HOOK_FLAGS =
  FLAG.BEFORE_INITIALIZE |
  FLAG.BEFORE_ADD_LIQUIDITY |
  FLAG.BEFORE_SWAP |
  FLAG.AFTER_SWAP |
  FLAG.BEFORE_SWAP_RETURNS_DELTA |
  FLAG.AFTER_SWAP_RETURNS_DELTA;

function create2Address(deployer, salt, initCodeHash) {
  return ethers.getCreate2Address(deployer, salt, initCodeHash);
}

/**
 * @param deployer      address of the CREATE2 deployer (HookDeployer)
 * @param initCode      full init code (creation bytecode + ABI-encoded constructor args)
 * @param flags         required permission bits (bigint)
 * @param maxIterations safety bound; expected work is ~2^14 hashes
 */
function mineHookSalt(deployer, initCode, flags = CURVE_HOOK_FLAGS, { start = 0n, maxIterations = 2_000_000 } = {}) {
  const initCodeHash = ethers.keccak256(initCode);
  for (let i = 0; i < maxIterations; i++) {
    const salt = ethers.toBeHex(start + BigInt(i), 32);
    const address = create2Address(deployer, salt, initCodeHash);
    if ((BigInt(address) & ALL_HOOK_MASK) === flags) return { salt, address, iterations: i + 1 };
  }
  throw new Error(`no salt found in ${maxIterations} iterations`);
}

module.exports = { ALL_HOOK_MASK, FLAG, CURVE_HOOK_FLAGS, mineHookSalt, create2Address };
