// Local stack for the examples: Eridanos protocol + HYPE preset on the in-process Hardhat network.
const hre = require("hardhat");
const { deployEridanos } = require("../scripts/lib/eridanos");
const { buildPresetFromCurve, HYPE_START_TICK, ASCEND_SHAPE } = require("../scripts/lib/presets");

async function localStack() {
  const [deployer, treasury, guardian] = await hre.ethers.getSigners();
  const stack = await deployEridanos(hre, { deployer, owner: deployer.address, treasury: treasury.address, guardian: guardian.address });
  await (await stack.config.setQuote(hre.ethers.ZeroAddress, true)).wait();
  await (await stack.config.addCurvePreset(hre.ethers.ZeroAddress, HYPE_START_TICK, buildPresetFromCurve(ASCEND_SHAPE))).wait();
  await (await stack.registry.setCore(await stack.core.getAddress(), true)).wait();
  return stack;
}

module.exports = { localStack };
