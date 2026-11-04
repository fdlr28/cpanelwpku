// Uniswap v4 helpers shared by tests and deploy scripts.
//
// The PoolManager is deployed from the canonical, pre-compiled artifact shipped in
// @uniswap/v4-core@1.0.2 (out/PoolManager.sol/PoolManager.json). We never recompile it, so the
// deployed runtime code can be checked byte-for-byte against the artifact.
const { ethers } = require("ethers");
const POOL_MANAGER_ARTIFACT = require("@uniswap/v4-core/out/PoolManager.sol/PoolManager.json");

const ADDRESS_ZERO = ethers.ZeroAddress; // native HYPE as a v4 Currency
const DYNAMIC_FEE_FLAG = 0x800000;
const Q96 = 1n << 96n;

function poolManagerFactory(signer) {
  return new ethers.ContractFactory(POOL_MANAGER_ARTIFACT.abi, POOL_MANAGER_ARTIFACT.bytecode.object, signer);
}

async function deployPoolManager(signer, initialOwner) {
  const pm = await poolManagerFactory(signer).deploy(initialOwner ?? (await signer.getAddress()));
  await pm.waitForDeployment();
  return pm;
}

/** Overwrites every immutable slot of a runtime bytecode hex string with zero bytes. */
function maskImmutables(runtimeHex, immutableReferences) {
  const bytes = ethers.getBytes(runtimeHex);
  for (const refs of Object.values(immutableReferences ?? {})) {
    for (const { start, length } of refs) bytes.fill(0, start, start + length);
  }
  return ethers.hexlify(bytes);
}

/** True when the code at `address` is the canonical PoolManager runtime (immutables masked). */
async function isCanonicalPoolManager(provider, address) {
  const onchain = await provider.getCode(address);
  const { object, immutableReferences } = POOL_MANAGER_ARTIFACT.deployedBytecode;
  return maskImmutables(onchain, immutableReferences) === maskImmutables(object, immutableReferences);
}

function sortCurrencies(a, b) {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

module.exports = {
  POOL_MANAGER_ARTIFACT,
  ADDRESS_ZERO,
  DYNAMIC_FEE_FLAG,
  Q96,
  deployPoolManager,
  isCanonicalPoolManager,
  maskImmutables,
  sortCurrencies,
};
