const { ethers } = require("hardhat");

/**
 * Builds a curve config whose DEX listing price equals the final curve price.
 *   virtualToken = S^2 / (2S - N)   (S = curve supply, N = total supply)
 *   HYPE raised at graduation = 3 * virtualNative for the default 1B / 800M split.
 */
function buildCurve({ totalSupply = "1000000000", curveSupply = "800000000", virtualNative = "100" } = {}) {
  const N = ethers.parseEther(totalSupply);
  const S = ethers.parseEther(curveSupply);
  if (2n * S <= N) throw new Error("curveSupply must be > totalSupply / 2");
  // Round down to whole tokens so the LP never needs more tokens than are left over
  // (the contract rejects configs where it would, see ElysiumLaunchpad._setCurveConfig).
  const ONE = 10n ** 18n;
  const virtualToken = ((S * S - 1n) / (2n * S - N) / ONE) * ONE;
  return { totalSupply: N, curveSupply: S, virtualNative: ethers.parseEther(virtualNative), virtualToken };
}

module.exports = { buildCurve };
