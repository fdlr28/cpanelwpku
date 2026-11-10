// Mainnet deploy of Eridanos v2 (on PancakeSwap Infinity CL) + Provenalt on Elysium MAINNET (99901).
// Run by the project owner from their own machine, with their own key in .env. This script never reads, asks for
// or prints a key; Hardhat signs with PRIVATE_KEY from .env.
//
//   Rehearsal, in-process (no key, nothing leaves the machine):
//     npx hardhat run scripts/deploy-mainnet-v2.js
//   Rehearsal on a copy of mainnet (real USDC, nothing is sent): see docs/desain/06-runbook-mainnet.md
//   Live (sends real transactions, costs real HYPE):
//     ADMIN=0x... CONFIRM=mainnet-99901 npx hardhat run scripts/deploy-mainnet-v2.js --network elysiumMainnet
//
// The whole admin handover finishes inside this run, with no window where the deployer key alone controls the
// protocol for 48 hours: the Timelock starts with delay 0 and the deployer as its only proposer (the deployer
// owns everything at that point anyway). One batch then makes the Timelock accept ownership of config, registry,
// core and the Infinity vault, gives ADMIN the proposer + canceller roles (taken from the deployer when they
// differ) and raises the delay to MAINNET_TIMELOCK_DELAY (48 h). The CL pool manager (single-step Ownable) goes to the
// Timelock directly. The script then checks every owner and role and stops with an error if one is wrong.
//
// Environment (values left in .env from the testnet template must not leak into mainnet: TIMELOCK_DELAY and
// POOL_MANAGER are ignored here, an empty APP_URI means the default, and live runs accept only the canonical USDC):
//   ADMIN             required live: the admin wallet (Timelock proposer + canceller; default for the next four)
//   TREASURY          protocol treasury                      (default ADMIN)
//   GUARDIAN          may pause new launches/registrations   (default ADMIN)
//   PROVENALT_OWNER   owner of the ProvenaltRouter           (default ADMIN)
//   PROVENALT_PAYOUT  receives Provenalt's integrator share  (default ADMIN)
//   MAINNET_TIMELOCK_DELAY  seconds, at least 172800 live    (default 172800 = 48 h)
//   APP_URI           website in the integrator registry    (default https://provenalt.xyz)
//   USDC              quote token for rehearsals            (default and only live value: canonical Elysium USDC)
//   HYPE_START_TICK / USDC_START_TICK   curve start ticks    (default: the testnet presets, scripts/lib/presets.js)
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { deployEridanos, deployAppRouter } = require("./lib/eridanos");
const { deployInfinity } = require("./lib/infinity");
const { NETWORKS } = require("./lib/networks");
const { ASCEND_SHAPE, HYPE_START_TICK, USDC_START_TICK, buildPresetFromCurve } = require("./lib/presets");

const MAINNET = 99901n;
const MIN_DELAY = 172800; // 48 h, the mainnet delay in the design (docs/desain/02)
const EST_GAS = 24_500_000n; // in-process rehearsal measures ~23.7 M; Elysium adds a small HyperEVM data fee
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { ethers, network } = hre;
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (chainId !== MAINNET && chainId !== 31337n) throw new Error(`Refusing chain ${chainId}: this script targets Elysium mainnet (99901) or a local rehearsal (31337).`);
  const live = chainId === MAINNET;
  if (live && process.env.CONFIRM !== "mainnet-99901") {
    throw new Error("Live MAINNET deploy: re-run with CONFIRM=mainnet-99901 after a successful rehearsal (docs/desain/06-runbook-mainnet.md).");
  }
  // On a fork of mainnet, state reads only work once a local block exists on top of the fork block.
  if (!live) await hre.network.provider.send("evm_mine", []);
  const outFile = path.join(__dirname, "..", "deployments", `${network.name}-v2.json`);
  const partialFile = outFile.replace(/\.json$/, ".partial.json");
  if (live && (fs.existsSync(outFile) || fs.existsSync(partialFile))) {
    throw new Error(`${path.relative(process.cwd(), fs.existsSync(outFile) ? outFile : partialFile)} already exists: a mainnet deploy was already started. Move the file away only if you really want a second deployment.`);
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer: set PRIVATE_KEY in .env (your own key).");
  const me = await deployer.getAddress();
  const addr = (k, d) => {
    const v = process.env[k];
    if (v === undefined || v === "") return d;
    const a = ethers.getAddress(v);
    if (a === ethers.ZeroAddress) throw new Error(`${k} is the zero address`);
    return a;
  };
  if (live && !process.env.ADMIN) throw new Error("Set ADMIN to the admin wallet (it receives the Timelock proposer + canceller roles).");
  const admin = addr("ADMIN", me);
  const treasury = addr("TREASURY", admin);
  const guardian = addr("GUARDIAN", admin);
  const provenaltOwner = addr("PROVENALT_OWNER", admin);
  const provenaltPayout = addr("PROVENALT_PAYOUT", admin);
  const delay = Number(process.env.MAINNET_TIMELOCK_DELAY || MIN_DELAY);
  if (!Number.isInteger(delay) || delay <= 0) throw new Error("MAINNET_TIMELOCK_DELAY must be a positive whole number of seconds");
  if (live && delay < MIN_DELAY) throw new Error(`MAINNET_TIMELOCK_DELAY ${delay}s is below the 48-hour mainnet minimum (${MIN_DELAY}s)`);
  const ignored = ["TIMELOCK_DELAY", "POOL_MANAGER", "TIMELOCK_PROPOSER"].filter((k) => process.env[k]);
  const appUri = process.env.APP_URI || "https://provenalt.xyz";
  const hypeTick = Number(process.env.HYPE_START_TICK || HYPE_START_TICK);
  const usdcTick = Number(process.env.USDC_START_TICK || USDC_START_TICK);

  // USDC: the canonical token, checked on chain (live, or a rehearsal on a mainnet fork); a 6-decimal mock otherwise.
  const mainnet = NETWORKS[99901];
  let usdc = addr("USDC", mainnet.usdc);
  if (live && usdc !== mainnet.usdc) throw new Error(`USDC ${usdc} is not the canonical Elysium USDC ${mainnet.usdc}; remove USDC from .env`);
  let usdcMock = false;
  if ((await ethers.provider.getCode(usdc)) === "0x") {
    if (live) throw new Error(`no contract at USDC ${usdc}`);
    usdc = await (await (await ethers.getContractFactory("MockUSDC", deployer)).deploy(10n ** 18n)).getAddress();
    usdcMock = true;
  } else {
    const t = new ethers.Contract(usdc, ["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function l1Address() view returns (address)"], ethers.provider);
    const [sym, dec] = [await t.symbol(), await t.decimals()];
    if (sym !== "USDC" || dec !== 6n) throw new Error(`${usdc} is ${sym} with ${dec} decimals, expected USDC with 6`);
    if (usdc === mainnet.usdc && (await t.l1Address()) !== mainnet.usdcL1) throw new Error("USDC l1Address is not Circle USDC on HyperEVM");
  }

  // Preflight: balance against the expected cost.
  const balance = await ethers.provider.getBalance(me);
  const fee = await ethers.provider.getFeeData();
  const gasPrice = fee.gasPrice ?? fee.maxFeePerGas ?? 0n;
  const estCost = EST_GAS * gasPrice;
  const pricePerToken = (tick, quoteDecimals) => Math.pow(1.0001, tick) * 10 ** (18 - quoteDecimals);
  const line = (k, v) => console.log(`  ${k.padEnd(18)} ${v}`);
  console.log(`${live ? "LIVE MAINNET DEPLOY" : "REHEARSAL"} on chain ${chainId} (${network.name})`);
  line("deployer", me);
  line("admin", `${admin}${admin === me ? " (= deployer)" : ""}`);
  line("treasury", treasury);
  line("guardian", guardian);
  line("router owner", provenaltOwner);
  line("router payout", provenaltPayout);
  line("timelock delay", `${delay} s (${(delay / 3600).toFixed(1)} h)`);
  line("app uri", appUri || "(empty)");
  line("USDC", `${usdc}${usdcMock ? " (mock, rehearsal)" : ""}`);
  line("HYPE preset", `tick ${hypeTick}: ${pricePerToken(hypeTick, 18).toExponential(3)} HYPE/token, start market cap ≈ ${(pricePerToken(hypeTick, 18) * 1e9).toFixed(1)} HYPE`);
  line("USDC preset", `tick ${usdcTick}: ${pricePerToken(usdcTick, 6).toExponential(3)} USDC/token, start market cap ≈ $${Math.round(pricePerToken(usdcTick, 6) * 1e9).toLocaleString("en-US")}`);
  line("balance", `${ethers.formatEther(balance)} HYPE`);
  if (ignored.length) line("ignored", `${ignored.join(", ")} (testnet settings, not used here)`);
  const notAdmin = [["TREASURY", treasury], ["GUARDIAN", guardian], ["PROVENALT_OWNER", provenaltOwner], ["PROVENALT_PAYOUT", provenaltPayout]]
    .filter(([, v]) => v !== admin).map(([k]) => k);
  if (notAdmin.length) line("check", `${notAdmin.join(", ")} ${notAdmin.length > 1 ? "differ" : "differs"} from ADMIN (set in the environment or .env)`);
  line("expected cost", `≈ ${ethers.formatEther(estCost)} HYPE at ${ethers.formatUnits(gasPrice, "gwei")} gwei`);
  if (live) {
    if (balance < (estCost * 3n) / 2n) throw new Error(`balance too low: keep at least ${ethers.formatEther((estCost * 3n) / 2n)} HYPE (1.5× the expected cost) on the deployer`);
    if (balance < estCost * 2n) console.log("  note: less than 2× the expected cost on the deployer; gas prices can move during the deploy");
    console.log("\nSending real transactions in 15 seconds. Ctrl+C to abort.");
    await sleep(15_000);
  }

  // Progress is written to <network>-v2.partial.json as it goes, so a failure midway leaves a record of what exists.
  const out = {
    network: network.name, chainId: Number(chainId), startedAt: new Date().toISOString(), deployer: me,
    poolEngine: "PancakeSwap Infinity CL (GPL-2.0-or-later)",
  };
  const save = (stage) => {
    out.stage = stage;
    if (live) fs.writeFileSync(partialFile, JSON.stringify(out, null, 2));
  };

  // 1. Pool engine: our own Infinity vault + CL pool manager from the vendored sources.
  const { vault: infVault, poolManager: pm } = await deployInfinity(hre, deployer);
  out.infinityVault = await infVault.getAddress();
  out.poolManager = await pm.getAddress();
  out.deployBlock = (await infVault.deploymentTransaction().wait()).blockNumber;
  save("infinity");

  // 2. Timelock, bootstrapped with delay 0 and the deployer as the only proposer; anyone may execute.
  const timelock = await (await ethers.getContractFactory("EridanosTimelock", deployer)).deploy(0, [me], [ethers.ZeroAddress], ethers.ZeroAddress);
  await timelock.waitForDeployment();
  const tl = await timelock.getAddress();
  out.timelock = tl;
  save("timelock");

  // 3. Protocol stack, owned by the deployer until the handover below.
  const stack = await deployEridanos(hre, { deployer, owner: me, treasury, guardian, poolManager: pm });
  const { config, registry, core, hook, distributor, vault } = stack;
  Object.assign(out, {
    config: await config.getAddress(), registry: await registry.getAddress(), core: await core.getAddress(), hook: await hook.getAddress(),
    distributor: await distributor.getAddress(), vault: await vault.getAddress(),
  });
  save("stack");

  // 4. Quotes and curve presets: 1 = HYPE, 2 = USDC.
  const curve = buildPresetFromCurve(ASCEND_SHAPE);
  await (await config.setQuote(ethers.ZeroAddress, true)).wait();
  await (await config.addCurvePreset(ethers.ZeroAddress, hypeTick, curve)).wait();
  await (await config.setQuote(usdc, true)).wait();
  await (await config.addCurvePreset(usdc, usdcTick, curve)).wait();
  await (await registry.setCore(out.core, true)).wait();
  out.usdc = usdc;
  save("presets");

  // 5. Provenalt router = integrator #1 (owner set in its constructor, no acceptance needed).
  const router = await deployAppRouter(hre, stack, {
    deployer, owner: provenaltOwner, name: "Provenalt", uri: appUri, signer: ethers.ZeroAddress, payout: provenaltPayout,
    policy: { integratorBps: 3000, maxAllocBps: 2000, maxDevBuyBps: 1000, minCliff: 0, minDuration: 0, devBuyLock: 0 },
  });
  out.router = await router.getAddress();
  save("router");

  // 6. Handover.
  if ((await pm.protocolFeeController()) !== ethers.ZeroAddress) throw new Error("unexpected protocol fee controller");
  await (await pm.transferOwnership(tl)).wait();
  const owned = [config, registry, core, infVault];
  for (const c of owned) await (await c.transferOwnership(tl)).wait();
  const ownedAddrs = await Promise.all(owned.map((c) => c.getAddress()));
  const calls = ownedAddrs.map((a) => [a, config.interface.encodeFunctionData("acceptOwnership")]);
  const [PROPOSER, CANCELLER, EXECUTOR, DEFAULT_ADMIN] = [
    await timelock.PROPOSER_ROLE(), await timelock.CANCELLER_ROLE(), await timelock.EXECUTOR_ROLE(), await timelock.DEFAULT_ADMIN_ROLE(),
  ];
  if (admin !== me) {
    for (const [fn, role, who] of [["grantRole", PROPOSER, admin], ["grantRole", CANCELLER, admin], ["revokeRole", PROPOSER, me], ["revokeRole", CANCELLER, me]]) {
      calls.push([tl, timelock.interface.encodeFunctionData(fn, [role, who])]);
    }
  }
  calls.push([tl, timelock.interface.encodeFunctionData("updateDelay", [delay])]); // last: raises the delay to 48 h
  const targets = calls.map((c) => c[0]);
  const data = calls.map((c) => c[1]);
  const values = calls.map(() => 0);
  const salt = ethers.id(`eridanos-v2-mainnet-bootstrap-${Date.now()}`);
  await (await timelock.scheduleBatch(targets, values, data, ethers.ZeroHash, salt, 0)).wait();
  await (await timelock.executeBatch(targets, values, data, ethers.ZeroHash, salt)).wait();
  out.bootstrap = { targets, data, salt, executed: true };
  save("handover");

  // 7. Check the end state; any mismatch stops here with an error.
  const problems = [];
  const expect = (label, ok) => { if (!ok) problems.push(label); };
  const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  for (const c of [...owned, pm]) {
    const a = await c.getAddress();
    expect(`owner of ${a} is the Timelock`, eq(await c.owner(), tl));
    if (c !== pm) expect(`no pending owner on ${a}`, eq(await c.pendingOwner(), ethers.ZeroAddress));
  }
  expect("pool manager has no protocol fee controller", eq(await pm.protocolFeeController(), ethers.ZeroAddress));
  expect("pool manager not paused", !(await pm.paused()));
  expect(`Timelock delay is ${delay}s`, (await timelock.getMinDelay()) === BigInt(delay));
  expect("admin is Timelock proposer", await timelock.hasRole(PROPOSER, admin));
  expect("admin is Timelock canceller", await timelock.hasRole(CANCELLER, admin));
  if (admin !== me) {
    expect("deployer is not proposer", !(await timelock.hasRole(PROPOSER, me)));
    expect("deployer is not canceller", !(await timelock.hasRole(CANCELLER, me)));
  }
  expect("anyone may execute", await timelock.hasRole(EXECUTOR, ethers.ZeroAddress));
  expect("Timelock administers itself", await timelock.hasRole(DEFAULT_ADMIN, tl));
  expect("deployer is not Timelock admin", !(await timelock.hasRole(DEFAULT_ADMIN, me)));
  expect("treasury", eq(await config.treasury(), treasury));
  expect("config guardian", eq(await config.guardian(), guardian));
  expect("registry guardian", eq(await registry.guardian(), guardian));
  expect("router owner", eq(await router.owner(), provenaltOwner));
  const rec = await registry.getIntegrator(1);
  expect("integrator #1 is the router", eq(rec.account, out.router));
  expect("integrator #1 payout", eq(rec.payout, provenaltPayout));
  expect("integrator #1 name", rec.name === "Provenalt");
  expect("deployer owns no integrator", (await registry.integratorOf(me)) === 0n);
  if (problems.length) {
    save("check-failed");
    throw new Error(`end-state check failed:\n  - ${problems.join("\n  - ")}`);
  }
  console.log(`\nend state checked ✓ Timelock (${delay}s) owns config, registry, core, the Infinity vault and the CL pool manager;`);
  console.log(`  ${admin} is ${admin === me ? "" : "the only "}Timelock proposer/canceller; treasury, guardian, router owner and payout set.`);

  Object.assign(out, {
    deployedAt: new Date().toISOString(), timelockDelay: delay, timelockAdmin: admin, treasury, guardian,
    provenaltOwner, provenaltPayout, appUri, presets: { 1: { quote: "HYPE", startTick: hypeTick }, 2: { quote: "USDC", startTick: usdcTick } },
    hiddenTokens: [],
  });
  delete out.stage;
  const spent = balance - (await ethers.provider.getBalance(me));
  console.log(`${live ? "HYPE spent" : "rehearsal cost (in-process gas, before the data fee)"}: ${ethers.formatEther(spent)} HYPE`);
  if (!live) {
    let gas = 0n;
    const end = await ethers.provider.getBlockNumber();
    for (let b = out.deployBlock; b <= end; b++) gas += (await ethers.provider.getBlock(b)).gasUsed;
    console.log(`gas used: ${gas}`);
  }

  if (live || network.name === "localhost") {
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
    if (fs.existsSync(partialFile)) fs.unlinkSync(partialFile);
    console.log(`\nSaved ${path.relative(process.cwd(), outFile)}.`);
  }
  console.log(JSON.stringify(out, null, 2));
  if (live) console.log("\nNext: docs/desain/06-runbook-mainnet.md (verify sources, indexer, website).");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

