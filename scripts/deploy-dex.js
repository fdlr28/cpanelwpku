// Deploys a Uniswap V2 factory + Router02 (canonical bytecode from @uniswap/v2-core /
// @uniswap/v2-periphery) for graduated tokens to trade on, until an official V2-compatible
// DEX is live on Elysium (the docs list Uniswap as "Announced").
//   npx hardhat run scripts/deploy-dex.js --network elysiumTestnet
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const UniswapV2Factory = require("@uniswap/v2-core/build/UniswapV2Factory.json");
const UniswapV2Router02 = require("@uniswap/v2-periphery/build/UniswapV2Router02.json");
const ADDR = require("./addresses");

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("Set PRIVATE_KEY in .env");
  const wrappedNative = process.env.WRAPPED_NATIVE || ADDR[network.name]?.WHYPE;
  if (!ethers.isAddress(wrappedNative || "")) throw new Error("Set WRAPPED_NATIVE (WHYPE) in .env");

  console.log(`Network: ${network.name}, deployer ${deployer.address}, WHYPE ${wrappedNative}`);
  const factory = await new ethers.ContractFactory(UniswapV2Factory.abi, UniswapV2Factory.bytecode, deployer).deploy(
    process.env.FEE_TO_SETTER || deployer.address
  );
  await factory.waitForDeployment();
  const router = await new ethers.ContractFactory(UniswapV2Router02.abi, UniswapV2Router02.bytecode, deployer).deploy(
    await factory.getAddress(),
    wrappedNative
  );
  await router.waitForDeployment();

  const out = {
    network: network.name,
    factory: await factory.getAddress(),
    router: await router.getAddress(),
    wrappedNative,
    deployedAt: new Date().toISOString(),
  };
  console.log(out);
  const file = path.join(__dirname, "..", "deployments", `${network.name}-dex.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Saved ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
