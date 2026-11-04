// Deploys and wires the full Eridanos v2 stack. Used by tests and (later) by the testnet deploy script.
//
// Order: PoolManager (given or new) → ProtocolConfig → IntegratorRegistry → VestingVault →
//        CurveHook (CREATE2, mined permission bits) → FeeDistributor → LaunchCore → bind + setCore.
const { ethers } = require("ethers");
const { deployPoolManager } = require("./v4");
const { mineHookSalt } = require("./hookMiner");

async function deployEridanos(hre, { deployer, owner, treasury, guardian, poolManager } = {}) {
  const signer = deployer;
  const ownerAddr = owner ?? (await signer.getAddress());
  const pm = poolManager ?? (await deployPoolManager(signer, ownerAddr));
  const pmAddr = await pm.getAddress();

  const factory = (name) => hre.ethers.getContractFactory(name, signer);
  const config = await (await factory("ProtocolConfig")).deploy(ownerAddr, treasury, guardian);
  const registry = await (await factory("IntegratorRegistry")).deploy(ownerAddr, guardian);
  const vault = await (await factory("VestingVault")).deploy();
  const hookDeployer = await (await factory("HookDeployer")).deploy();

  const Hook = await factory("CurveHook");
  const initCode = ethers.concat([
    Hook.bytecode,
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [pmAddr, await signer.getAddress()]),
  ]);
  const { salt, address: hookAddr } = mineHookSalt(await hookDeployer.getAddress(), initCode);
  await (await hookDeployer.deploy(salt, initCode)).wait();
  const hook = Hook.attach(hookAddr);

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

  return { pm, config, registry, vault, hook, distributor, core, hookDeployer, hookSalt: salt };
}

module.exports = { deployEridanos };
