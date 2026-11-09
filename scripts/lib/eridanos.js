// Deploys and wires the full Eridanos v2 stack on PancakeSwap Infinity. Used by tests and deploy scripts.
//
// Order: Infinity vault + CL pool manager (given or new) → ProtocolConfig → IntegratorRegistry → VestingVault →
//        CurveHook → FeeDistributor → LaunchCore → bind + setCore (by the caller).
const { deployInfinity } = require("./infinity");

async function deployEridanos(hre, { deployer, owner, treasury, guardian, poolManager } = {}) {
  const signer = deployer;
  const ownerAddr = owner ?? (await signer.getAddress());
  let pm = poolManager;
  let infVault;
  if (!pm) ({ vault: infVault, poolManager: pm } = await deployInfinity(hre, signer));
  else infVault = await hre.ethers.getContractAt("Vault", await pm.vault(), signer);
  const pmAddr = await pm.getAddress();

  const factory = (name) => hre.ethers.getContractFactory(name, signer);
  const config = await (await factory("ProtocolConfig")).deploy(ownerAddr, treasury, guardian);
  const registry = await (await factory("IntegratorRegistry")).deploy(ownerAddr, guardian);
  const vault = await (await factory("VestingVault")).deploy();
  const hook = await (await factory("CurveHook")).deploy(pmAddr, await signer.getAddress());
  await hook.waitForDeployment();
  const hookAddr = await hook.getAddress();

  const distributor = await (await factory("FeeDistributor")).deploy(await registry.getAddress(), await config.getAddress());
  const core = await (await factory("LaunchCore")).deploy(
    ownerAddr,
    pmAddr,
    await config.getAddress(),
    await registry.getAddress(),
    await vault.getAddress(),
    hookAddr,
    await distributor.getAddress()
  );
  await (await hook.bind(await core.getAddress(), await distributor.getAddress())).wait();
  await (await distributor.bind(await core.getAddress(), hookAddr)).wait();

  return { pm, infVault, config, registry, vault, hook, distributor, core };
}

/** Deploys an app router and registers it as an integrator (it becomes the record's account). */
async function deployAppRouter(hre, stack, { deployer, owner, name, uri = "", signer, payout, policy }) {
  const Router = await hre.ethers.getContractFactory("ProvenaltRouter", deployer);
  const router = await Router.deploy(owner, await stack.core.getAddress(), name, uri, signer, payout, policy);
  await router.waitForDeployment();
  return router;
}

module.exports = { deployEridanos, deployAppRouter };
