// Moves every admin role of a deployment from the current deployer to NEW_ADMIN.
//   NEW_ADMIN=0x... CONFIRM=yes npx hardhat run scripts/handover-admin.js --network elysiumTestnet           (step 1)
//   NEW_ADMIN=0x... CONFIRM=yes STEP=execute npx hardhat run scripts/handover-admin.js --network elysiumTestnet (step 2, after the delay)
//
// Step 1 (deployer, immediate):
//   * HypelysRouter: setPayout(NEW_ADMIN), transferOwnership(NEW_ADMIN)  → NEW_ADMIN must call acceptOwnership()
//   * integrator records owned directly by the deployer (smoke-test integrators): payout → NEW_ADMIN, deactivated
//   * Timelock batch scheduled: grant PROPOSER + CANCELLER to NEW_ADMIN, revoke them from the deployer,
//     ProtocolConfig.setTreasury/setGuardian and IntegratorRegistry.setGuardian → NEW_ADMIN
// Step 2 (anyone, after the Timelock delay): executes the batch.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const { ethers, network } = hre;
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (![99801n, 31337n].includes(chainId)) throw new Error(`Refusing chain ${chainId}`);
  if (chainId === 99801n && process.env.CONFIRM !== "yes") throw new Error("Re-run with CONFIRM=yes");
  const newAdmin = ethers.getAddress(process.env.NEW_ADMIN || "");
  const file = path.join(__dirname, "..", "deployments", `${network.name}-v2.json`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const [me] = await ethers.getSigners();
  const at = (n, a) => ethers.getContractAt(n, a, me);
  const tl = await at("EridanosTimelock", d.timelock);
  const config = await at("ProtocolConfig", d.config);
  const registry = await at("IntegratorRegistry", d.registry);
  const router = await at("HypelysRouter", d.router);
  const PROPOSER = await tl.PROPOSER_ROLE();
  const CANCELLER = await tl.CANCELLER_ROLE();
  const tlAddr = d.timelock;

  const calls = [
    [tlAddr, tl.interface.encodeFunctionData("grantRole", [PROPOSER, newAdmin])],
    [tlAddr, tl.interface.encodeFunctionData("grantRole", [CANCELLER, newAdmin])],
    [d.config, config.interface.encodeFunctionData("setTreasury", [newAdmin])],
    [d.config, config.interface.encodeFunctionData("setGuardian", [newAdmin])],
    [d.registry, registry.interface.encodeFunctionData("setGuardian", [newAdmin])],
    [tlAddr, tl.interface.encodeFunctionData("revokeRole", [PROPOSER, d.deployer])],
    [tlAddr, tl.interface.encodeFunctionData("revokeRole", [CANCELLER, d.deployer])],
  ];
  const targets = calls.map((c) => c[0]);
  const data = calls.map((c) => c[1]);
  const values = calls.map(() => 0);

  if (process.env.STEP === "execute") {
    const h = d.adminHandover;
    if (!h) throw new Error("no scheduled handover in deployment file");
    await (await tl.executeBatch(h.targets, h.targets.map(() => 0), h.data, ethers.ZeroHash, h.salt)).wait();
    h.executed = true;
    fs.writeFileSync(file, JSON.stringify(d, null, 2));
  } else {
    // --- direct transfers
    if ((await router.owner()) === me.address) {
      await (await router.setPayout(newAdmin)).wait();
      await (await router.transferOwnership(newAdmin)).wait();
    }
    const myId = await registry.integratorOf(me.address);
    if (myId !== 0n) {
      await (await registry.setPayout(myId, newAdmin)).wait();
      await (await registry.setSelfActive(myId, false)).wait();
    }
    // --- timelock batch
    const delay = await tl.getMinDelay();
    const salt = ethers.id(`eridanos-v2-admin-handover-${Date.now()}`);
    await (await tl.scheduleBatch(targets, values, data, ethers.ZeroHash, salt, delay)).wait();
    const ts = (await ethers.provider.getBlock("latest")).timestamp + Number(delay);
    d.adminHandover = { newAdmin, targets, data, salt, executableAfter: ts, deactivatedIntegrator: Number(myId), executed: false };
    fs.writeFileSync(file, JSON.stringify(d, null, 2));
    console.log(`scheduled; executable after ${new Date(ts * 1000).toISOString()}`);
  }

  // --- status
  const reg1 = await registry.getIntegrator(1);
  console.log({
    routerOwner: await router.owner(), routerPendingOwner: await router.pendingOwner(), provenaltPayout: reg1.payout,
    treasury: await config.treasury(), configGuardian: await config.guardian(), registryGuardian: await registry.guardian(),
    newAdminProposer: await tl.hasRole(PROPOSER, newAdmin), newAdminCanceller: await tl.hasRole(CANCELLER, newAdmin),
    deployerProposer: await tl.hasRole(PROPOSER, d.deployer),
  });
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
