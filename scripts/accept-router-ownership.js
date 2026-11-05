// Run by the new admin (PRIVATE_KEY in .env = the wallet that was handed HypelysRouter ownership):
//   CONFIRM=yes npx hardhat run scripts/accept-router-ownership.js --network elysiumTestnet
// Accepts HypelysRouter ownership and prints the admin status of the deployment.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const { ethers, network } = hre;
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (chainId !== 99801n && chainId !== 31337n) throw new Error(`Refusing chain ${chainId}`);
  if (chainId === 99801n && process.env.CONFIRM !== "yes") throw new Error("Re-run with CONFIRM=yes");
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}-v2.json`), "utf8"));
  const [me] = await ethers.getSigners();
  if (!me) throw new Error("No signer: set PRIVATE_KEY in .env");
  console.log(`wallet ${me.address}, balance ${ethers.formatEther(await ethers.provider.getBalance(me))} HYPE`);

  const router = await ethers.getContractAt("HypelysRouter", d.router, me);
  const pending = await router.pendingOwner();
  if ((await router.owner()) === me.address) {
    console.log("already owner of HypelysRouter ✓");
  } else if (pending !== me.address) {
    throw new Error(`this wallet is not the pending owner (pending = ${pending})`);
  } else {
    const rc = await (await router.acceptOwnership()).wait();
    console.log(`acceptOwnership tx ${rc.hash}`);
  }

  const tl = await ethers.getContractAt("EridanosTimelock", d.timelock, me);
  const config = await ethers.getContractAt("ProtocolConfig", d.config, me);
  const registry = await ethers.getContractAt("IntegratorRegistry", d.registry, me);
  const ok = (b) => (b ? "✓" : "✗ (waiting for the timelock batch)");
  console.log(`HypelysRouter owner : ${await router.owner()} ${ok((await router.owner()) === me.address)}`);
  console.log(`Hypelys payout      : ${(await registry.getIntegrator(1)).payout}`);
  console.log(`Timelock proposer   : ${ok(await tl.hasRole(await tl.PROPOSER_ROLE(), me.address))}`);
  console.log(`Timelock canceller  : ${ok(await tl.hasRole(await tl.CANCELLER_ROLE(), me.address))}`);
  console.log(`treasury            : ${await config.treasury()}`);
  console.log(`guardian (config)   : ${await config.guardian()}`);
  console.log(`guardian (registry) : ${await registry.guardian()}`);
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exitCode = 1; });
