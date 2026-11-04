// Shared fixture for the Eridanos launch/attack suites: full stack on a canonical v4 PoolManager,
// HYPE and USDC presets, integrator #1 ("Hypelys"), v4-core test routers.
const hre = require("hardhat");
const { ethers } = hre;
const { deployEridanos } = require("../../scripts/lib/eridanos");
const { HYPE_START_TICK, ASCEND_CURVE, MAX_POLICY } = require("./helpers");

const E = (n) => ethers.parseEther(String(n));
const PIPS = 1_000_000n;
const BASE = 10_000n;
const START = 900_000n;
const DECAY = 10n;
const DEAD = "0x000000000000000000000000000000000000dEaD";
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
const USDC_START_TICK = -393800; // ≈ 7.9e-6 USDC (6 decimals) per token (18 decimals)

function scheduleFee(elapsed) {
  const e = BigInt(elapsed);
  if (e >= DECAY) return BASE;
  return BASE + ((START - BASE) * (DECAY - e)) / DECAY;
}
function surchargeRate(elapsed) {
  const f = scheduleFee(elapsed);
  return f <= BASE ? 0n : ((f - BASE) * PIPS) / (PIPS - BASE);
}
/** Exact-input surcharge: s = X·(f − BASE)/(1 − BASE). */
function exactInSurcharge(amount, elapsed) {
  const f = scheduleFee(elapsed);
  return f <= BASE ? 0n : (amount * (f - BASE)) / (PIPS - BASE);
}

async function fixture() {
  const [owner, treasury, guardian, app, appSigner, payout, creator, alice, bob, user] = await ethers.getSigners();
  const stack = await deployEridanos(hre, { deployer: owner, owner: owner.address, treasury: treasury.address, guardian: guardian.address });
  const { config, registry, core, pm } = stack;

  await config.setQuote(ethers.ZeroAddress, true);
  await config.addCurvePreset(ethers.ZeroAddress, HYPE_START_TICK, ASCEND_CURVE); // preset 1: HYPE
  const usdc = await ethers.deployContract("TestERC20", [10n ** 30n]);
  await config.setQuote(await usdc.getAddress(), true);
  await config.addCurvePreset(await usdc.getAddress(), USDC_START_TICK, ASCEND_CURVE); // preset 2: USDC
  await registry.setCore(await core.getAddress(), true);
  await registry.connect(app).register("Hypelys", "https://hypelys.example", appSigner.address, payout.address, MAX_POLICY);

  const router = await ethers.deployContract("PoolSwapTest", [await pm.getAddress()]);
  const lpRouter = await ethers.deployContract("PoolModifyLiquidityTest", [await pm.getAddress()]);
  for (const s of [alice, bob, user, creator]) {
    await usdc.transfer(s.address, 10n ** 24n);
    await usdc.connect(s).approve(await router.getAddress(), ethers.MaxUint256);
    await usdc.connect(s).approve(await core.getAddress(), ethers.MaxUint256);
  }
  return { ...stack, owner, treasury, guardian, app, appSigner, payout, creator, alice, bob, user, usdc, router, lpRouter };
}

function params(creator, overrides = {}) {
  return {
    name: "Elysian Cat",
    symbol: "ECAT",
    metadataURI: "ipfs://cat",
    salt: ethers.id(overrides.saltLabel ?? "s1"),
    creator,
    presetId: 1,
    allocations: [],
    cliff: 0,
    duration: 0,
    devBuyTokens: 0n,
    maxDevBuyQuote: 0n,
    ...overrides,
    saltLabel: undefined,
  };
}
const clean = (p) => { const { saltLabel, ...rest } = p; return rest; };

async function doLaunch(ctx, signer, p, value = 0n) {
  const tx = await ctx.core.connect(signer).launch(clean(p), { value });
  const rc = await tx.wait();
  const ev = rc.logs.map((l) => { try { return ctx.core.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
  const token = await ethers.getContractAt("EridanosToken", ev.args.token);
  const block = await ethers.provider.getBlock(rc.blockNumber);
  return { rc, ev, token, poolId: ev.args.record.poolId, launchedAt: block.timestamp };
}

async function keyOf(ctx, poolId) {
  const [info, key] = await ctx.hook.poolInfo(poolId);
  return { info, key: { currency0: key.currency0, currency1: key.currency1, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks } };
}

const SETTINGS = { takeClaims: false, settleUsingBurn: false };

/** amount > 0: exact input of `amount`; amount < 0 handled by exactOut flag. */
async function swap(ctx, signer, poolId, { buy, amount, exactOut = false }) {
  const { info, key } = await keyOf(ctx, poolId);
  const zeroForOne = buy ? !info.tokenIs0 : info.tokenIs0;
  const paysNative = buy && info.quote === ethers.ZeroAddress;
  const p = { zeroForOne, amountSpecified: exactOut ? amount : -amount, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT };
  const value = paysNative ? (exactOut ? E(1000) : amount) : 0n;
  const tx = await ctx.router.connect(signer).swap(key, p, SETTINGS, "0x", { value });
  return tx.wait();
}

function events(ctx, rc, contract, name) {
  return rc.logs.map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } }).filter((e) => e && e.name === name);
}


module.exports = {
  E, PIPS, BASE, START, DECAY, DEAD, MIN_SQRT, MAX_SQRT, USDC_START_TICK, SETTINGS,
  scheduleFee, surchargeRate, exactInSurcharge, fixture, params, clean, doLaunch, keyOf, swap, events,
};
