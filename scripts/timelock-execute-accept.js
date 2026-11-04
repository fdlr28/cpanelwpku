// Executes the acceptOwnership batch scheduled by deploy-testnet-v2.js once the Timelock delay has passed.
//   npx hardhat run scripts/timelock-execute-accept.js --network elysiumTestnet
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const { ethers, network } = hre;
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}-v2.json`), "utf8"));
  const timelock = await ethers.getContractAt("EridanosTimelock", d.timelock);
  const { targets, data, salt } = d.acceptOwnership;
  await (await timelock.executeBatch(targets, targets.map(() => 0), data, ethers.ZeroHash, salt)).wait();
  for (const t of targets) {
    const owner = await (await ethers.getContractAt("Ownable2Step", t)).owner();
    console.log(t, "owner", owner, owner === d.timelock ? "✓" : "✗");
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
