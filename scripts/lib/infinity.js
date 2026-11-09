// PancakeSwap Infinity helpers shared by tests and deploy scripts.
//
// The vault and CL pool manager are compiled from the vendored, unmodified sources in
// contracts/vendor/infinity (GPL-2.0-or-later, see NOTICE.md). Hook permissions live in the low 16 bits of
// PoolKey.parameters (no hook address mining), the tick spacing at bits 16–39.
const { ethers } = require("ethers");

const ADDRESS_ZERO = ethers.ZeroAddress; // native HYPE as an Infinity Currency
const DYNAMIC_FEE_FLAG = 0x800000;
const Q96 = 1n << 96n;
const TICK_SPACING = 200;

const HOOK_OFFSETS = {
  beforeInitialize: 0, afterInitialize: 1, beforeAddLiquidity: 2, afterAddLiquidity: 3, beforeRemoveLiquidity: 4,
  afterRemoveLiquidity: 5, beforeSwap: 6, afterSwap: 7, beforeDonate: 8, afterDonate: 9,
  beforeSwapReturnsDelta: 10, afterSwapReturnsDelta: 11, afterAddLiquidityReturnsDelta: 12,
  afterRemoveLiquidityReturnsDelta: 13,
};
const bitmapOf = (names) => names.reduce((m, n) => m | (1 << HOOK_OFFSETS[n]), 0);
// Must equal CurveHookFlags.BITMAP in Solidity.
const CURVE_HOOK_BITMAP = bitmapOf(["beforeInitialize", "beforeAddLiquidity", "beforeSwap", "afterSwap", "beforeSwapReturnsDelta", "afterSwapReturnsDelta"]);

/** PoolKey.parameters for a CL pool: hook bitmap | tickSpacing << 16. */
function clParameters(bitmap, tickSpacing = TICK_SPACING) {
  return ethers.toBeHex((BigInt(tickSpacing) << 16n) | BigInt(bitmap), 32);
}

/** Deploys a vault and a CL pool manager (owned by the signer) and registers the pool manager as a vault app. */
async function deployInfinity(hre, signer) {
  const vault = await (await hre.ethers.getContractFactory("Vault", signer)).deploy();
  await vault.waitForDeployment();
  const poolManager = await (await hre.ethers.getContractFactory("CLPoolManager", signer)).deploy(await vault.getAddress());
  await poolManager.waitForDeployment();
  await (await vault.registerApp(await poolManager.getAddress())).wait();
  return { vault, poolManager };
}

function sortCurrencies(a, b) {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

module.exports = {
  ADDRESS_ZERO, DYNAMIC_FEE_FLAG, Q96, TICK_SPACING, HOOK_OFFSETS, CURVE_HOOK_BITMAP,
  bitmapOf, clParameters, deployInfinity, sortCurrencies,
};
