// Deploys ElysiumLaunchpad to a live network (Elysium testnet / mainnet).
//   npx hardhat run scripts/deploy.js --network elysiumTestnet
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { buildCurve } = require("./curve");

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("Set PRIVATE_KEY in .env");

  const dexFactory = process.env.DEX_FACTORY;
  const wrappedNative = process.env.WRAPPED_NATIVE;
  if (!ethers.isAddress(dexFactory || "")) throw new Error("Set DEX_FACTORY (Uniswap-V2-compatible factory) in .env");
  if (!ethers.isAddress(wrappedNative || "")) throw new Error("Set WRAPPED_NATIVE (WHYPE) in .env");
  const feeRecipient = process.env.FEE_RECIPIENT || deployer.address;

  const curve = buildCurve({
    totalSupply: process.env.TOTAL_SUPPLY,
    curveSupply: process.env.CURVE_SUPPLY,
    virtualNative: process.env.VIRTUAL_NATIVE,
  });

  console.log(`Network:  ${network.name} (chainId ${network.config.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} HYPE`);
  console.log("Curve:", Object.fromEntries(Object.entries(curve).map(([k, v]) => [k, ethers.formatEther(v)])));

  const launchpad = await ethers.deployContract("ElysiumLaunchpad", [
    deployer.address,
    dexFactory,
    wrappedNative,
    feeRecipient,
    curve,
  ]);
  await launchpad.waitForDeployment();
  const address = await launchpad.getAddress();
  const receipt = await launchpad.deploymentTransaction().wait();
  console.log(`ElysiumLaunchpad: ${address}`);

  const out = {
    network: network.name,
    chainId: network.config.chainId,
    launchpad: address,
    deployBlock: receipt.blockNumber,
    dexFactory,
    wrappedNative,
    feeRecipient,
    deployedAt: new Date().toISOString(),
  };
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Saved ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
