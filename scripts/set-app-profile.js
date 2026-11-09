// Renames the app's integrator record in the Eridanos registry (shown by frontends and explorers).
// Run by the owner of the app router (PRIVATE_KEY in .env):
//   CONFIRM=yes npx hardhat run scripts/set-app-profile.js --network elysiumTestnet
// Optional: APP_NAME (default "Provenalt"), APP_URI (website; default empty, max length enforced on-chain).
// Takes effect immediately (no Timelock): the router owner controls its own registry record.
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
  const name = process.env.APP_NAME || "Provenalt";
  const uri = process.env.APP_URI || "";

  const router = await ethers.getContractAt("ProvenaltRouter", d.router, me);
  const registry = await ethers.getContractAt("IntegratorRegistry", d.registry, me);
  const owner = await router.owner();
  if (owner !== me.address) throw new Error(`this wallet (${me.address}) is not the router owner (${owner})`);
  const id = await router.integratorId();
  const before = await registry.getIntegrator(id);
  console.log(`integrator #${id}: "${before.name}" ${before.uri || "(no uri)"}`);
  if (before.name === name && before.uri === uri) { console.log("already set ✓"); return; }

  const rc = await (await router.setProfile(name, uri)).wait();
  const after = await registry.getIntegrator(id);
  console.log(`setProfile tx ${rc.hash}`);
  console.log(`integrator #${id}: "${after.name}" ${after.uri || "(no uri)"} ${after.name === name ? "✓" : "✗"}`);
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exitCode = 1; });
