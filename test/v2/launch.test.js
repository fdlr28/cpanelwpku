// Phase 3: LaunchCore + CurveHook + FeeDistributor on a canonical Uniswap v4 PoolManager.
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployEridanos } = require("../../scripts/lib/eridanos");
const { SUPPLY, DAY, HYPE_START_TICK, ASCEND_CURVE, MAX_POLICY, signIntent } = require("./helpers");

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

describe("v2 phase 3 · launch, curve, fees", function () {
  describe("launch modes and supply", function () {
    it("mode C: no integrator, 20 / 0 / 80, whole supply on the curve, nothing left behind", async function () {
      const ctx = await loadFixture(fixture);
      const { ev, token, poolId } = await doLaunch(ctx, ctx.user, params(ctx.creator.address));
      const r = ev.args.record;
      expect(ev.args.integratorId).to.equal(0n);
      expect(r.attribution).to.equal(0n);
      expect(r.caller).to.equal(ctx.user.address);
      expect([r.protocolBps, r.integratorBps, r.creatorBps]).to.deep.equal([2000n, 0n, 8000n]);
      expect(r.poolTokens).to.equal(SUPPLY);

      const pmBal = await token.balanceOf(await ctx.pm.getAddress());
      const dust = await token.balanceOf(DEAD);
      expect(pmBal + dust).to.equal(SUPPLY);
      expect(dust).to.be.lt(1_000_000n); // rounding of 15 band amounts, burned
      for (const holder of [ctx.core, ctx.hook]) expect(await token.balanceOf(await holder.getAddress())).to.equal(0n);
      for (let i = 0; i < ASCEND_CURVE.length; i++) expect(await ctx.hook.bandLiquidity(poolId, i)).to.be.gt(0n);

      const [terms, p, i_, c] = await ctx.distributor.feeTerms(poolId);
      expect([p, i_, c]).to.deep.equal([2000n, 0n, 8000n]);
      expect(terms.creator).to.equal(ctx.creator.address);
    });

    it("mode A: integrator account calls; policy share recorded; instant allocation and dev buy disclosed", async function () {
      const ctx = await loadFixture(fixture);
      const devBuyTokens = SUPPLY / 10n; // 10% cap
      const p = params(ctx.creator.address, {
        allocations: [{ recipient: ctx.creator.address, bps: 1500 }, { recipient: ctx.bob.address, bps: 500 }],
        devBuyTokens,
        maxDevBuyQuote: E(500),
      });
      const before = await ethers.provider.getBalance(ctx.app.address);
      const { ev, token, rc } = await doLaunch(ctx, ctx.app, p, E(500));
      const r = ev.args.record;
      expect(ev.args.integratorId).to.equal(1n);
      expect(r.attribution).to.equal(1n);
      expect([r.protocolBps, r.integratorBps, r.creatorBps]).to.deep.equal([2000n, 3000n, 5000n]);
      expect(r.allocBps).to.equal(2000n);
      expect(r.instantAllocation).to.equal(true);
      expect(r.devBuyTokens).to.equal(devBuyTokens);

      // 15% + dev buy to creator, 5% to bob, all instant.
      expect(await token.balanceOf(ctx.creator.address)).to.equal((SUPPLY * 1500n) / 10_000n + devBuyTokens);
      expect(await token.balanceOf(ctx.bob.address)).to.equal((SUPPLY * 500n) / 10_000n);
      expect(r.poolTokens).to.equal((SUPPLY * 8000n) / 10_000n);

      // Unspent dev-buy HYPE refunded to the caller; dev buy paid no surcharge.
      const gas = rc.gasUsed * rc.gasPrice;
      const after = await ethers.provider.getBalance(ctx.app.address);
      expect(before - after - gas).to.equal(r.devBuyQuoteSpent);
      expect(r.devBuyQuoteSpent).to.be.lt(E(500));
      expect(events(ctx, rc, ctx.hook, "SurchargeCharged").length).to.equal(0);
      expect(await token.balanceOf(await ctx.core.getAddress())).to.equal(0n);
    });

    it("mode A with a vesting allocation and a dev-buy lock from the integrator policy", async function () {
      const ctx = await loadFixture(fixture);
      await ctx.registry.connect(ctx.app).queuePolicy(1, { ...MAX_POLICY, minCliff: 30 * DAY, minDuration: 365 * DAY, devBuyLock: 90 * DAY });
      await time.increase(DAY);
      const p = params(ctx.creator.address, { allocations: [{ recipient: ctx.creator.address, bps: 1000 }], cliff: 30 * DAY, duration: 365 * DAY, devBuyTokens: E(1_000_000), maxDevBuyQuote: E(10) });
      const { ev, token } = await doLaunch(ctx, ctx.app, p, E(10));
      expect(ev.args.record.instantAllocation).to.equal(false);
      expect(ev.args.record.devBuyLock).to.equal(BigInt(90 * DAY));
      expect(await token.balanceOf(ctx.creator.address)).to.equal(0n); // everything is in the vault
      expect(await token.balanceOf(await ctx.vault.getAddress())).to.equal(SUPPLY / 10n + E(1_000_000));

      // Policy minimums are enforced.
      const tooShort = params(ctx.creator.address, { saltLabel: "s2", allocations: [{ recipient: ctx.creator.address, bps: 1000 }], cliff: 0, duration: 0 });
      await expect(ctx.core.connect(ctx.app).launch(clean(tooShort))).to.be.revertedWithCustomError(ctx.core, "AllocationNotAllowed");
    });

    it("mode B: user launches with the integrator's signature; tampering is rejected", async function () {
      const ctx = await loadFixture(fixture);
      const p = clean(params(ctx.creator.address));
      const intent = {
        integratorId: 1,
        core: await ctx.core.getAddress(),
        caller: ctx.user.address,
        creator: ctx.creator.address,
        paramsHash: await ctx.core.hashParams(p),
        nonce: 42n,
        deadline: BigInt((await time.latest()) + 3600),
      };
      const sig = await signIntent(ctx.appSigner, ctx.registry, intent);

      await expect(ctx.core.connect(ctx.bob).launchSigned(p, intent, sig)).to.be.revertedWithCustomError(ctx.core, "IntentMismatch");
      const changed = { ...p, presetId: 2 };
      await expect(ctx.core.connect(ctx.user).launchSigned(changed, intent, sig)).to.be.revertedWithCustomError(ctx.core, "IntentMismatch");

      const rc = await (await ctx.core.connect(ctx.user).launchSigned(p, intent, sig)).wait();
      const ev = events(ctx, rc, ctx.core, "Launched")[0];
      expect(ev.args.integratorId).to.equal(1n);
      expect(ev.args.record.attribution).to.equal(2n);
      expect(ev.args.record.caller).to.equal(ctx.user.address);
      await expect(ctx.core.connect(ctx.user).launchSigned({ ...p, salt: ethers.id("x") }, intent, sig)).to.be.revertedWithCustomError(ctx.core, "IntentMismatch");
    });

    it("predicts the token address from caller and salt", async function () {
      const ctx = await loadFixture(fixture);
      const p = params(ctx.creator.address);
      const predicted = await ctx.core.predictToken(ctx.user.address, clean(p));
      const { token } = await doLaunch(ctx, ctx.user, p);
      expect(await token.getAddress()).to.equal(predicted);
      // Same salt from another caller gives another address, so a salt cannot be front-run.
      expect(await ctx.core.predictToken(ctx.bob.address, clean(p))).to.not.equal(predicted);
    });
  });

  describe("bounds", function () {
    it("rejects allocations above 20%, more than 3 recipients, cliff > duration", async function () {
      const ctx = await loadFixture(fixture);
      const c = ctx.creator.address;
      const bad = [
        { allocations: [{ recipient: c, bps: 2001 }] },
        { allocations: [1, 2, 3, 4].map(() => ({ recipient: c, bps: 100 })) },
        { allocations: [{ recipient: c, bps: 100 }], cliff: 10, duration: 5 },
        { allocations: [], cliff: 5, duration: 5 },
        { allocations: [{ recipient: ethers.ZeroAddress, bps: 100 }] },
      ];
      for (const o of bad) {
        await expect(ctx.core.connect(ctx.user).launch(clean(params(c, o)))).to.be.revertedWithCustomError(ctx.core, "AllocationNotAllowed");
      }
    });

    it("rejects dev buys above 10% or above the integrator's cap, and wrong funds", async function () {
      const ctx = await loadFixture(fixture);
      const c = ctx.creator.address;
      await expect(ctx.core.connect(ctx.user).launch(clean(params(c, { devBuyTokens: SUPPLY / 10n + 1n, maxDevBuyQuote: E(1) })), { value: E(1) }))
        .to.be.revertedWithCustomError(ctx.core, "DevBuyNotAllowed");
      await expect(ctx.core.connect(ctx.user).launch(clean(params(c, { devBuyTokens: E(1), maxDevBuyQuote: E(1) })), { value: E(2) }))
        .to.be.revertedWithCustomError(ctx.core, "WrongFunds");
      await ctx.registry.connect(ctx.app).queuePolicy(1, { ...MAX_POLICY, maxDevBuyBps: 200 });
      await time.increase(DAY);
      await expect(ctx.core.connect(ctx.app).launch(clean(params(c, { devBuyTokens: SUPPLY / 40n, maxDevBuyQuote: E(100) })), { value: E(100) }))
        .to.be.revertedWithCustomError(ctx.core, "DevBuyNotAllowed");
    });

    it("guardian pauses new launches, only the owner unpauses; disabled presets are refused", async function () {
      const ctx = await loadFixture(fixture);
      await ctx.core.connect(ctx.guardian).pause();
      await expect(ctx.core.connect(ctx.user).launch(clean(params(ctx.creator.address)))).to.be.revertedWithCustomError(ctx.core, "Paused");
      await expect(ctx.core.connect(ctx.guardian).unpause()).to.be.revertedWithCustomError(ctx.core, "OwnableUnauthorizedAccount");
      await ctx.core.connect(ctx.owner).unpause();
      await ctx.config.setCurvePresetEnabled(1, false);
      await expect(ctx.core.connect(ctx.user).launch(clean(params(ctx.creator.address)))).to.be.revertedWithCustomError(ctx.core, "PresetNotUsable");
    });

    it("a suspended integrator cannot launch in mode A", async function () {
      const ctx = await loadFixture(fixture);
      await ctx.registry.connect(ctx.owner).setSuspended(1, true);
      await expect(ctx.core.connect(ctx.app).launch(clean(params(ctx.creator.address)))).to.be.revertedWithCustomError(ctx.core, "IntegratorCannotLaunch");
    });
  });

  describe("anti-sniper fee", function () {
    it("exact-input buys pay f(t) in total: surcharge to protocol, 1% LP fee; nothing after 10 s", async function () {
      const ctx = await loadFixture(fixture);
      const { poolId, launchedAt } = await doLaunch(ctx, ctx.user, params(ctx.creator.address));
      const amount = E(1);
      for (const elapsed of [1, 3, 9, 10, 25]) {
        await time.setNextBlockTimestamp(launchedAt + elapsed);
        const rc = await swap(ctx, ctx.alice, poolId, { buy: true, amount });
        const sur = events(ctx, rc, ctx.hook, "SurchargeCharged");
        const expected = exactInSurcharge(amount, elapsed);
        if (expected === 0n) {
          expect(sur.length).to.equal(0);
        } else {
          expect(sur[0].args.amount).to.equal(expected);
          expect(sur[0].args.currency).to.equal(ethers.ZeroAddress);
          expect(sur[0].args.exactInput).to.equal(true);
        }
        // Total effective fee: surcharge + 1% of the rest equals f(t) (within rounding).
        const total = expected + ((amount - expected) * BASE) / PIPS;
        const target = (amount * scheduleFee(elapsed)) / PIPS;
        expect(total).to.be.closeTo(target, 2n);
      }
      expect(await ctx.hook.currentFee(poolId)).to.equal(BASE);
    });

    it("exact-output buys are charged in afterSwap at the same total rate", async function () {
      const ctx = await loadFixture(fixture);
      const { poolId, launchedAt } = await doLaunch(ctx, ctx.user, params(ctx.creator.address));
      await time.setNextBlockTimestamp(launchedAt + 2);
      const before = await ethers.provider.getBalance(ctx.alice.address);
      const rc = await swap(ctx, ctx.alice, poolId, { buy: true, amount: E(1_000_000), exactOut: true });
      const paid = before - (await ethers.provider.getBalance(ctx.alice.address)) - rc.gasUsed * rc.gasPrice;
      const sur = events(ctx, rc, ctx.hook, "SurchargeCharged")[0];
      expect(sur.args.exactInput).to.equal(false);
      // surcharge / gross input == rate (within rounding)
      expect((sur.args.amount * PIPS) / paid).to.be.closeTo(surchargeRate(2), 1n);
    });

    it("sells in the window pay the surcharge in the token, which is burned on collect", async function () {
      const ctx = await loadFixture(fixture);
      const { poolId, launchedAt, token } = await doLaunch(ctx, ctx.user, params(ctx.creator.address));
      await swap(ctx, ctx.alice, poolId, { buy: true, amount: E(5) });
      await token.connect(ctx.alice).approve(await ctx.router.getAddress(), ethers.MaxUint256);
      await time.setNextBlockTimestamp(launchedAt + 5);
      const sellAmount = (await token.balanceOf(ctx.alice.address)) / 2n;
      const rc = await swap(ctx, ctx.alice, poolId, { buy: false, amount: sellAmount });
      const sur = events(ctx, rc, ctx.hook, "SurchargeCharged")[0];
      expect(sur.args.currency).to.equal(await token.getAddress());
      expect(sur.args.amount).to.equal(exactInSurcharge(sellAmount, 5));

      const deadBefore = await token.balanceOf(DEAD);
      const crc = await (await ctx.hook.collect(poolId)).wait();
      const flushed = events(ctx, crc, ctx.hook, "SurchargeFlushed").find((e) => e.args.currency === (sur.args.currency));
      expect(flushed.args.burned).to.equal(true);
      expect((await token.balanceOf(DEAD)) - deadBefore).to.equal(sur.args.amount);
    });

    it("the creator buying in the first seconds pays the surcharge like anyone else", async function () {
      const ctx = await loadFixture(fixture);
      const { poolId, launchedAt } = await doLaunch(ctx, ctx.creator, params(ctx.creator.address));
      await time.setNextBlockTimestamp(launchedAt + 1);
      const rc = await swap(ctx, ctx.creator, poolId, { buy: true, amount: E(1) });
      expect(events(ctx, rc, ctx.hook, "SurchargeCharged")[0].args.amount).to.equal(exactInSurcharge(E(1), 1));
    });
  });

  describe("fee split and claims", function () {
    it("splits the base fee 20 / 30 / 50 (mode A), sends the quote surcharge to the protocol, pays every role", async function () {
      const ctx = await loadFixture(fixture);
      const { poolId, launchedAt, token } = await doLaunch(ctx, ctx.app, params(ctx.creator.address));
      await time.setNextBlockTimestamp(launchedAt + 1);
      const r1 = await swap(ctx, ctx.alice, poolId, { buy: true, amount: E(2) }); // in the window
      const surcharge = events(ctx, r1, ctx.hook, "SurchargeCharged")[0].args.amount;
      await time.setNextBlockTimestamp(launchedAt + 60);
      await swap(ctx, ctx.bob, poolId, { buy: true, amount: E(3) });
      await token.connect(ctx.bob).approve(await ctx.router.getAddress(), ethers.MaxUint256);
      await swap(ctx, ctx.bob, poolId, { buy: false, amount: (await token.balanceOf(ctx.bob.address)) / 3n });

      const crc = await (await ctx.hook.collect(poolId)).wait();
      const splits = events(ctx, crc, ctx.distributor, "FeesSplit");
      for (const s of splits) {
        expect(s.args.toProtocol).to.equal((s.args.amount * 2000n) / 10_000n);
        expect(s.args.toIntegrator).to.equal((s.args.amount * 3000n) / 10_000n);
        expect(s.args.toProtocol + s.args.toIntegrator + s.args.toCreator).to.equal(s.args.amount);
      }
      const quoteSplit = splits.find((s) => s.args.currency === ethers.ZeroAddress);
      // Base fee on the HYPE side: 1% of the input left after the surcharge.
      const expectedQuoteFees = ((E(2) - surcharge) * BASE) / PIPS + (E(3) * BASE) / PIPS;
      expect(quoteSplit.args.amount).to.be.closeTo(expectedQuoteFees, 4n);
      expect(await ctx.distributor.protocolOwed(ethers.ZeroAddress)).to.equal(quoteSplit.args.toProtocol + surcharge);

      await expect(ctx.distributor.claimCreator(poolId)).to.changeEtherBalance(ctx.creator, quoteSplit.args.toCreator);
      await expect(ctx.distributor.claimIntegrator(1, ethers.ZeroAddress)).to.changeEtherBalance(ctx.payout, quoteSplit.args.toIntegrator);
      await expect(ctx.distributor.claimProtocol(ethers.ZeroAddress)).to.changeEtherBalance(ctx.treasury, quoteSplit.args.toProtocol + surcharge);
      expect(await ethers.provider.getBalance(await ctx.distributor.getAddress())).to.equal(0n);

      // Token-side fees from the sell are claimable too, and nothing is stranded.
      const tokenAddr = await token.getAddress();
      const tokenSplit = splits.find((s) => s.args.currency === tokenAddr);
      expect(await token.balanceOf(ctx.creator.address)).to.equal(tokenSplit.args.toCreator);
      await ctx.distributor.claimIntegrator(1, await token.getAddress());
      await ctx.distributor.claimProtocol(await token.getAddress());
      expect(await token.balanceOf(await ctx.distributor.getAddress())).to.equal(0n);
    });

    it("mode C pays the creator 80% and no integrator", async function () {
      const ctx = await loadFixture(fixture);
      const { poolId, launchedAt } = await doLaunch(ctx, ctx.user, params(ctx.creator.address));
      await time.setNextBlockTimestamp(launchedAt + 60);
      await swap(ctx, ctx.alice, poolId, { buy: true, amount: E(10) });
      const crc = await (await ctx.hook.collect(poolId)).wait();
      const s = events(ctx, crc, ctx.distributor, "FeesSplit")[0];
      expect(s.args.toIntegrator).to.equal(0n);
      expect(s.args.toCreator).to.equal(s.args.amount - (s.args.amount * 2000n) / 10_000n);
    });

    it("the dev buy pays the 1% base fee into the split", async function () {
      const ctx = await loadFixture(fixture);
      const { poolId, ev } = await doLaunch(ctx, ctx.user, params(ctx.creator.address, { devBuyTokens: E(10_000_000), maxDevBuyQuote: E(50) }), E(50));
      const spent = ev.args.record.devBuyQuoteSpent;
      const crc = await (await ctx.hook.collect(poolId)).wait();
      const s = events(ctx, crc, ctx.distributor, "FeesSplit")[0];
      // exact-output fee = ceil(amountIn · fee / (1e6 − fee)) and spent = amountIn + fee  ⇒ fee ≈ spent · 1%
      expect(s.args.amount).to.be.closeTo((spent * BASE) / PIPS, 2n);
    });

    it("the creator role moves in two steps and claims follow it", async function () {
      const ctx = await loadFixture(fixture);
      const { poolId, launchedAt } = await doLaunch(ctx, ctx.user, params(ctx.creator.address));
      await expect(ctx.distributor.connect(ctx.bob).transferCreator(poolId, ctx.bob.address)).to.be.revertedWithCustomError(ctx.distributor, "NotCreator");
      await ctx.distributor.connect(ctx.creator).transferCreator(poolId, ctx.bob.address);
      await ctx.distributor.connect(ctx.bob).acceptCreator(poolId);
      await time.setNextBlockTimestamp(launchedAt + 60);
      await swap(ctx, ctx.alice, poolId, { buy: true, amount: E(10) });
      await ctx.hook.collect(poolId);
      const owed = await ctx.distributor.creatorOwed(poolId, ethers.ZeroAddress);
      await expect(ctx.distributor.connect(ctx.creator).claimCreator(poolId)).to.changeEtherBalance(ctx.bob, owed);
    });
  });

  describe("closed pool and locked liquidity", function () {
    it("refuses third-party pools on our hook and third-party liquidity", async function () {
      const ctx = await loadFixture(fixture);
      const { poolId } = await doLaunch(ctx, ctx.user, params(ctx.creator.address));
      const { key } = await keyOf(ctx, poolId);
      const other = { ...key, currency1: await ctx.usdc.getAddress(), currency0: ethers.ZeroAddress };
      await expect(ctx.pm.initialize(other, 2n ** 96n)).to.be.reverted;
      await ctx.usdc.connect(ctx.alice).approve(await ctx.lpRouter.getAddress(), ethers.MaxUint256);
      const lp = { tickLower: -887200, tickUpper: 887200, liquidityDelta: 10n ** 18n, salt: ethers.ZeroHash };
      await expect(ctx.lpRouter.connect(ctx.alice)["modifyLiquidity((address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)"](key, lp, "0x", { value: E(1) })).to.be.reverted;
    });

    it("never decreases band liquidity across trading and collects", async function () {
      const ctx = await loadFixture(fixture);
      const { poolId, launchedAt, token } = await doLaunch(ctx, ctx.user, params(ctx.creator.address));
      const before = [];
      for (let i = 0; i < ASCEND_CURVE.length; i++) before.push(await ctx.hook.bandLiquidity(poolId, i));
      await time.setNextBlockTimestamp(launchedAt + 30);
      await token.connect(ctx.alice).approve(await ctx.router.getAddress(), ethers.MaxUint256);
      for (let k = 0; k < 6; k++) {
        await swap(ctx, ctx.alice, poolId, { buy: true, amount: E(20 + k) });
        await swap(ctx, ctx.alice, poolId, { buy: false, amount: (await token.balanceOf(ctx.alice.address)) / 2n });
        await ctx.hook.collect(poolId);
      }
      for (let i = 0; i < ASCEND_CURVE.length; i++) expect(await ctx.hook.bandLiquidity(poolId, i)).to.equal(before[i]);
    });

    it("conserves supply: PoolManager + holders + vault + burned dust = 1e27", async function () {
      const ctx = await loadFixture(fixture);
      const p = params(ctx.creator.address, { allocations: [{ recipient: ctx.creator.address, bps: 1000 }], cliff: 0, duration: 400 * DAY, devBuyTokens: E(5_000_000), maxDevBuyQuote: E(20) });
      const { poolId, launchedAt, token } = await doLaunch(ctx, ctx.user, p, E(20));
      await time.setNextBlockTimestamp(launchedAt + 2);
      await swap(ctx, ctx.alice, poolId, { buy: true, amount: E(7) });
      await token.connect(ctx.alice).approve(await ctx.router.getAddress(), ethers.MaxUint256);
      await swap(ctx, ctx.alice, poolId, { buy: false, amount: (await token.balanceOf(ctx.alice.address)) / 4n });
      await ctx.hook.collect(poolId);
      const holders = [ctx.pm, ctx.vault, ctx.distributor, ctx.hook, ctx.core].map((c) => c.getAddress());
      let sum = 0n;
      for (const a of [...(await Promise.all(holders)), ctx.creator.address, ctx.alice.address, DEAD]) sum += await token.balanceOf(a);
      expect(sum).to.equal(SUPPLY);
      expect(await token.totalSupply()).to.equal(SUPPLY);
    });
  });

  describe("ERC-20 quote (USDC)", function () {
    it("launches against USDC with a dev buy pulled from the caller and refunds the rest", async function () {
      const ctx = await loadFixture(fixture);
      const p = params(ctx.creator.address, { presetId: 2, devBuyTokens: E(1_000_000), maxDevBuyQuote: 1_000n * 10n ** 18n });
      const before = await ctx.usdc.balanceOf(ctx.user.address);
      const { ev, poolId, launchedAt } = await doLaunch(ctx, ctx.user, p);
      expect(ev.args.record.quote).to.equal(await ctx.usdc.getAddress());
      expect(before - (await ctx.usdc.balanceOf(ctx.user.address))).to.equal(ev.args.record.devBuyQuoteSpent);

      await time.setNextBlockTimestamp(launchedAt + 1);
      const rc = await swap(ctx, ctx.alice, poolId, { buy: true, amount: 10n ** 21n });
      const sur = events(ctx, rc, ctx.hook, "SurchargeCharged")[0];
      expect(sur.args.currency).to.equal(await ctx.usdc.getAddress());
      await ctx.hook.collect(poolId);
      expect(await ctx.distributor.protocolOwed(await ctx.usdc.getAddress())).to.be.gte(sur.args.amount);
    });
  });
});
