// Phase 6 deploy script for Eridanos v2 + Provenalt on Elysium TESTNET (99801).
//
//   Dry run (in-process Hardhat network, no keys, nothing leaves this machine):
//     npx hardhat run scripts/deploy-testnet-v2.js
//   Live (run by the project owner with their own key in .env):
//     CONFIRM=yes npx hardhat run scripts/deploy-testnet-v2.js --network elysiumTestnet
//
// Refuses any chain other than 99801 (testnet) and 31337 (local) — mainnet is out of scope.
//
// Environment (all optional except PRIVATE_KEY for live runs):
//   POOL_MANAGER      existing canonical v4 PoolManager to use (checked byte-for-byte); empty = deploy one
//   TREASURY          protocol treasury                         (default: deployer)
//   GUARDIAN          may pause new launches/registrations      (default: deployer)
//   TIMELOCK_PROPOSER Safe multisig that proposes admin changes (default: deployer)
//   TIMELOCK_DELAY    seconds                                    (default: 3600)
//   USDC              ERC-20 quote; empty string disables       (default: Elysium testnet USDC)
//   PROVENALT_OWNER   owner of the Provenalt router (HypelysRouter contract) (default: deployer)
//   PROVENALT_PAYOUT  receives Provenalt's integrator share     (default: deployer)
//   APP_URI           website shown in the integrator registry  (default: empty)
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { deployEridanos, deployAppRouter } = require("./lib/eridanos");
const { deployPoolManager, isCanonicalPoolManager, POOL_MANAGER_ARTIFACT } = require("./lib/v4");
const { ASCEND_SHAPE, HYPE_START_TICK, USDC_START_TICK, buildPresetFromCurve } = require("./lib/presets");

const TESTNET_USDC = "0x7D29d8047B905000459c0E80c34a26CeedcB47b2";
const ALLOWED_CHAINS = new Set([99801n, 31337n]);

async function main() {
  const { ethers, network } = hre;
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (!ALLOWED_CHAINS.has(chainId)) throw new Error(`Refusing chain ${chainId}: this script only targets Elysium testnet (99801).`);
  const live = chainId === 99801n;
  if (live && process.env.CONFIRM !== "yes") throw new Error("Live testnet deploy: re-run with CONFIRM=yes after a successful dry run.");

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer: set PRIVATE_KEY in .env (your own key).");
  const me = await deployer.getAddress();
  const env = (k, d) => (process.env[k] === undefined || process.env[k] === "" ? d : process.env[k]);
  const treasury = env("TREASURY", me);
  const guardian = env("GUARDIAN", me);
  const proposer = env("TIMELOCK_PROPOSER", me);
  const delay = Number(env("TIMELOCK_DELAY", "3600"));
  const usdcEnv = process.env.USDC === undefined ? (live ? TESTNET_USDC : "mock") : process.env.USDC;
  const provenaltOwner = env("PROVENALT_OWNER", me);
  const provenaltPayout = env("PROVENALT_PAYOUT", me);

  console.log(`${live ? "LIVE" : "DRY RUN"} on chain ${chainId} (${network.name}) as ${me}`);
  const startBlock = await ethers.provider.getBlockNumber();
  const startBalance = await ethers.provider.getBalance(me);
  console.log(`balance ${ethers.formatEther(await ethers.provider.getBalance(me))} HYPE`);

  // 1. PoolManager: reuse a canonical one (e.g. an official Uniswap deployment) or deploy our own.
  let pm;
  if (process.env.POOL_MANAGER) {
    pm = new ethers.Contract(process.env.POOL_MANAGER, POOL_MANAGER_ARTIFACT.abi, deployer);
    if (!(await isCanonicalPoolManager(ethers.provider, process.env.POOL_MANAGER))) {
      throw new Error("POOL_MANAGER is not the canonical v4-core 1.0.2 PoolManager bytecode.");
    }
    console.log(`using PoolManager ${process.env.POOL_MANAGER} (owner ${await pm.owner()})`);
  } else {
    pm = await deployPoolManager(deployer, me);
    console.log(`deployed PoolManager ${await pm.getAddress()}`);
  }

  // 2. Timelock.
  const timelock = await (await ethers.getContractFactory("EridanosTimelock", deployer)).deploy(delay, [proposer], [ethers.ZeroAddress], ethers.ZeroAddress);
  await timelock.waitForDeployment();

  // 3. Protocol stack, initially owned by the deployer so it can be configured.
  const stack = await deployEridanos(hre, { deployer, owner: me, treasury, guardian, poolManager: pm });
  const { config, registry, core, hook, distributor, vault } = stack;

  // 4. Quotes and presets.
  const curve = buildPresetFromCurve(ASCEND_SHAPE);
  await (await config.setQuote(ethers.ZeroAddress, true)).wait();
  await (await config.addCurvePreset(ethers.ZeroAddress, HYPE_START_TICK, curve)).wait();
  let usdc = "";
  if (usdcEnv) {
    usdc = usdcEnv === "mock" ? await (await (await ethers.getContractFactory("TestERC20", deployer)).deploy(10n ** 30n)).getAddress() : usdcEnv;
    await (await config.setQuote(usdc, true)).wait();
    await (await config.addCurvePreset(usdc, USDC_START_TICK, curve)).wait();
  }
  await (await registry.setCore(await core.getAddress(), true)).wait();

  // 5. Provenalt router = integrator #1.
  const router = await deployAppRouter(hre, stack, {
    deployer, owner: provenaltOwner, name: "Provenalt", uri: env("APP_URI", ""),
    signer: ethers.ZeroAddress, payout: provenaltPayout,
    policy: { integratorBps: 3000, maxAllocBps: 2000, maxDevBuyBps: 1000, minCliff: 0, minDuration: 0, devBuyLock: 0 },
  });

  // 6. Hand admin over to the Timelock. Ownable2Step contracts need acceptOwnership from the Timelock,
  //    scheduled here (the deployer must be the proposer) and executable by anyone after the delay.
  const tl = await timelock.getAddress();
  for (const c of [config, registry, core]) await (await c.transferOwnership(tl)).wait();
  const targets = [await config.getAddress(), await registry.getAddress(), await core.getAddress()];
  const data = targets.map(() => config.interface.encodeFunctionData("acceptOwnership"));
  const values = targets.map(() => 0);
  const salt = ethers.id(`eridanos-v2-accept-${Date.now()}`);
  let scheduled = false;
  if (proposer.toLowerCase() === me.toLowerCase()) {
    await (await timelock.scheduleBatch(targets, values, data, ethers.ZeroHash, salt, delay)).wait();
    scheduled = true;
  }
  // PoolManager (if we deployed it): protocol fee controller stays unset, ownership to the Timelock.
  const pmOwned = (await pm.owner()).toLowerCase() === me.toLowerCase();
  if (pmOwned) {
    if ((await pm.protocolFeeController()) !== ethers.ZeroAddress) throw new Error("unexpected protocol fee controller");
    await (await pm.transferOwnership(tl)).wait();
  }

  const out = {
    network: network.name, chainId: Number(chainId), deployedAt: new Date().toISOString(), deployer: me,
    poolManager: await pm.getAddress(), timelock: tl, timelockDelay: delay, timelockProposer: proposer,
    config: targets[0], registry: targets[1], core: targets[2], hook: await hook.getAddress(),
    distributor: await distributor.getAddress(), vault: await vault.getAddress(), router: await router.getAddress(),
    hookDeployer: await stack.hookDeployer.getAddress(), hookSalt: stack.hookSalt, usdc, treasury, guardian,
    acceptOwnership: { targets, data, salt, scheduled, executableAfter: scheduled ? (await ethers.provider.getBlock("latest")).timestamp + delay : null },
  };

  if (!live) {
    // Prove the handover completes: wait out the delay and execute as an arbitrary account.
    await hre.network.provider.send("evm_increaseTime", [delay]);
    await hre.network.provider.send("evm_mine", []);
    await (await timelock.executeBatch(targets, values, data, ethers.ZeroHash, salt)).wait();
    for (const c of [config, registry, core]) if ((await c.owner()) !== tl) throw new Error("ownership handover failed");
    if ((await pm.owner()) !== tl) throw new Error("PoolManager handover failed");
    console.log("dry run: timelock now owns config, registry, core and PoolManager ✓");
  }

  if (!live) {
    let gas = 0n;
    const end = await ethers.provider.getBlockNumber();
    for (let b = startBlock + 1; b <= end; b++) gas += (await ethers.provider.getBlock(b)).gasUsed;
    console.log(`gas used by the deploy: ${gas}`);
  } else {
    console.log(`HYPE spent: ${ethers.formatEther(startBalance - (await ethers.provider.getBalance(me)))}`);
  }

  const file = path.join(__dirname, "..", "deployments", `${network.name}-v2.json`);
  if (live) fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  if (live) {
    console.log(`\nSaved ${path.relative(process.cwd(), file)}.`);
    console.log(scheduled
      ? `After ${delay}s anyone can run: npx hardhat run scripts/timelock-execute-accept.js --network ${network.name}`
      : "Proposer is not the deployer: have the proposer schedule the acceptOwnership batch shown above.");
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
