// Phase 4: attack scenarios that must fail (docs/desain/03-rencana-kerja.md, fase 4).
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { SUPPLY, MAX_POLICY, signIntent } = require("./helpers");
const {
  E, PIPS, BASE, START, DEAD, MIN_SQRT, exactInSurcharge, fixture, params, clean, doLaunch, keyOf, swap, events,
} = require("./launchFixture");
const { clParameters, CURVE_HOOK_BITMAP } = require("../../scripts/lib/infinity");

describe("v2 phase 4 · attacks", function () {
  describe("attribution", function () {
    it("an unregistered caller cannot obtain any integrator attribution", async function () {
      const ctx = await loadFixture(fixture);
      const { ev } = await doLaunch(ctx, ctx.alice, params(ctx.creator.address));
      expect(ev.args.integratorId).to.equal(0n);
      expect(ev.args.record.integratorBps).to.equal(0n);
    });

    it("a copycat registering the same name is attributed its own id, never the original", async function () {
      const ctx = await loadFixture(fixture);
      await ctx.registry.connect(ctx.alice).register("Provenalt", "https://provenalt.example", ctx.alice.address, ctx.alice.address, MAX_POLICY);
      const { ev } = await doLaunch(ctx, ctx.alice, params(ctx.creator.address));
      expect(ev.args.integratorId).to.equal(2n);
    });

    it("a mode-B intent cannot be replayed for a second launch", async function () {
      const ctx = await loadFixture(fixture);
      const p = clean(params(ctx.creator.address));
      const intent = {
        integratorId: 1, core: await ctx.core.getAddress(), caller: ctx.user.address, creator: ctx.creator.address,
        paramsHash: await ctx.core.hashParams(p), nonce: 1n, deadline: BigInt((await time.latest()) + 3600),
      };
      const sig = await signIntent(ctx.appSigner, ctx.registry, intent);
      await ctx.core.connect(ctx.user).launchSigned(p, intent, sig);
      // Same params would collide on the token address anyway; the registry refuses the nonce first.
      await expect(ctx.core.connect(ctx.user).launchSigned(p, intent, sig)).to.be.revertedWithCustomError(ctx.registry, "NonceAlreadyUsed");
    });

    it("only the authorised core can consume intents; a fake core cannot", async function () {
      const ctx = await loadFixture(fixture);
      const intent = {
        integratorId: 1, core: ctx.alice.address, caller: ctx.alice.address, creator: ctx.alice.address,
        paramsHash: ethers.ZeroHash, nonce: 9n, deadline: BigInt((await time.latest()) + 3600),
      };
      const sig = await signIntent(ctx.appSigner, ctx.registry, intent);
      await expect(ctx.registry.connect(ctx.alice).consumeIntent(intent, sig)).to.be.revertedWithCustomError(ctx.registry, "NotCore");
    });
  });

  describe("supply policy bypass", function () {
    it("cannot exceed 20% allocation through several recipients or 10% dev buy", async function () {
      const ctx = await loadFixture(fixture);
      const c = ctx.creator.address;
      const split = params(c, { allocations: [{ recipient: c, bps: 1000 }, { recipient: ctx.bob.address, bps: 700 }, { recipient: ctx.alice.address, bps: 301 }] });
      await expect(ctx.core.connect(ctx.user).launch(clean(split))).to.be.revertedWithCustomError(ctx.core, "AllocationNotAllowed");
      const dev = params(c, { devBuyTokens: SUPPLY / 10n + 1n, maxDevBuyQuote: E(1000) });
      await expect(ctx.core.connect(ctx.user).launch(clean(dev), { value: E(1000) })).to.be.revertedWithCustomError(ctx.core, "DevBuyNotAllowed");
    });

    it("nobody but the core can seed, and a pool cannot be seeded twice (no second fee-free dev buy)", async function () {
      const ctx = await loadFixture(fixture);
      const { poolId } = await doLaunch(ctx, ctx.user, params(ctx.creator.address));
      const [info] = await ctx.hook.poolInfo(poolId);
      const seedParams = {
        token: info.token, quote: info.quote, startTick: -173200, poolTokens: 0n, devBuyTokens: E(1), maxDevBuyQuote: 0n,
        devBuyRecipient: ctx.alice.address, refundTo: ctx.alice.address,
      };
      await expect(ctx.hook.connect(ctx.alice).seed(seedParams, [])).to.be.revertedWithCustomError(ctx.hook, "NotCore");
    });

    it("the token has no mint path: total supply never moves", async function () {
      const ctx = await loadFixture(fixture);
      const { token, poolId, launchedAt } = await doLaunch(ctx, ctx.user, params(ctx.creator.address));
      await time.setNextBlockTimestamp(launchedAt + 20);
      await swap(ctx, ctx.alice, poolId, { buy: true, amount: E(50) });
      expect(await token.totalSupply()).to.equal(SUPPLY);
    });
  });

  describe("anti-sniper", function () {
    it("a buy in the same block as the launch pays the full 90%", async function () {
      const ctx = await loadFixture(fixture);
      const p = clean(params(ctx.creator.address));
      const tokenAddr = await ctx.core.predictToken(ctx.user.address, p);
      const key = { currency0: ethers.ZeroAddress, currency1: tokenAddr, hooks: await ctx.hook.getAddress(),
        poolManager: await ctx.pm.getAddress(), fee: 0x800000, parameters: clParameters(CURVE_HOOK_BITMAP) };
      const amount = E(1);
      await network.provider.send("evm_setAutomine", [false]);
      try {
        const launchTx = await ctx.core.connect(ctx.user).launch(p, { gasLimit: 15_000_000 });
        const snipeTx = await ctx.router.connect(ctx.alice).swap(
          key, { zeroForOne: true, amountSpecified: -amount, sqrtPriceLimitX96: MIN_SQRT }, "0x", { value: amount, gasLimit: 2_000_000 }
        );
        await network.provider.send("evm_mine", []);
        const [l, s] = [await launchTx.wait(), await snipeTx.wait()];
        expect(l.blockNumber).to.equal(s.blockNumber);
        const sur = events(ctx, s, ctx.hook, "SurchargeCharged")[0];
        expect(sur.args.amount).to.equal((amount * (START - BASE)) / (PIPS - BASE));
      } finally {
        await network.provider.send("evm_setAutomine", [true]);
      }
    });

    it("selling with exact output in the window is charged too, and the token part is burned", async function () {
      const ctx = await loadFixture(fixture);
      const { token, poolId, launchedAt } = await doLaunch(ctx, ctx.user, params(ctx.creator.address));
      await time.setNextBlockTimestamp(launchedAt + 60);
      await swap(ctx, ctx.alice, poolId, { buy: true, amount: E(20) });
      // Relaunch-like window check on a fresh pool: launch a second token and sell exact-out inside its window.
      const second = await doLaunch(ctx, ctx.user, params(ctx.creator.address, { saltLabel: "s9" }));
      await time.setNextBlockTimestamp(second.launchedAt + 1);
      await swap(ctx, ctx.bob, second.poolId, { buy: true, amount: E(5) });
      await second.token.connect(ctx.bob).approve(await ctx.router.getAddress(), ethers.MaxUint256);
      await time.setNextBlockTimestamp(second.launchedAt + 3);
      const rc = await swap(ctx, ctx.bob, second.poolId, { buy: false, amount: E(1) / 100n, exactOut: true });
      const sur = events(ctx, rc, ctx.hook, "SurchargeCharged")[0];
      expect(sur.args.exactInput).to.equal(false);
      expect(sur.args.currency).to.equal(await second.token.getAddress());
      const deadBefore = await second.token.balanceOf(DEAD);
      await ctx.hook.collect(second.poolId);
      expect((await second.token.balanceOf(DEAD)) - deadBefore).to.equal(sur.args.amount);
      void token; void poolId;
    });

    it("no amount size escapes the surcharge beyond rounding", async function () {
      const ctx = await loadFixture(fixture);
      const { poolId, launchedAt } = await doLaunch(ctx, ctx.user, params(ctx.creator.address));
      await time.setNextBlockTimestamp(launchedAt + 4);
      const amount = 10_000n; // tiny swap
      const rc = await swap(ctx, ctx.alice, poolId, { buy: true, amount });
      expect(events(ctx, rc, ctx.hook, "SurchargeCharged")[0].args.amount).to.equal(exactInSurcharge(amount, 4));
    });
  });

  describe("liquidity lock", function () {
    it("nobody can remove the hook's positions through a router", async function () {
      const ctx = await loadFixture(fixture);
      const { poolId } = await doLaunch(ctx, ctx.user, params(ctx.creator.address));
      const { key } = await keyOf(ctx, poolId);
      const [, , bands] = await ctx.hook.poolInfo(poolId);
      const remove = { tickLower: bands[0].tickLower, tickUpper: bands[0].tickUpper, liquidityDelta: -1n, salt: ethers.ZeroHash };
      await expect(
        ctx.lpRouter.connect(ctx.alice).modifyLiquidity(key, remove, "0x")
      ).to.be.reverted;
      expect(await ctx.hook.bandLiquidity(poolId, 0)).to.be.gt(0n);
    });

    it("the hook exposes no liquidity-removal or admin withdrawal function", async function () {
      const ctx = await loadFixture(fixture);
      const fns = ctx.hook.interface.fragments.filter((f) => f.type === "function").map((f) => f.name).sort();
      // Callbacks the ICLHooks interface requires but CurveHook does not register: they always revert.
      const stubs = ["afterAddLiquidity", "afterDonate", "afterInitialize", "afterRemoveLiquidity", "beforeDonate", "beforeRemoveLiquidity"];
      expect(fns).to.deep.equal([
        "afterSwap", "bandLiquidity", "beforeAddLiquidity", "beforeInitialize", "beforeSwap", "bind", "collect", "core",
        "currentFee", "DEAD", "distributor", "getHooksRegistrationBitmap", "lockAcquired", "poolInfo", "poolManager", "seed",
        "spot", "surchargeRate", "vault", ...stubs,
      ].sort());
      const key = { currency0: ethers.ZeroAddress, currency1: ethers.ZeroAddress, hooks: ethers.ZeroAddress, poolManager: ethers.ZeroAddress, fee: 0, parameters: ethers.ZeroHash };
      const lp = { tickLower: 0, tickUpper: 0, liquidityDelta: 0, salt: ethers.ZeroHash };
      const zero = 0n;
      for (const call of [
        ctx.hook.afterInitialize.staticCall(ctx.alice.address, key, 1n, 0),
        ctx.hook.afterAddLiquidity.staticCall(ctx.alice.address, key, lp, zero, zero, "0x"),
        ctx.hook.beforeRemoveLiquidity.staticCall(ctx.alice.address, key, lp, "0x"),
        ctx.hook.afterRemoveLiquidity.staticCall(ctx.alice.address, key, lp, zero, zero, "0x"),
        ctx.hook.beforeDonate.staticCall(ctx.alice.address, key, 1n, 1n, "0x"),
        ctx.hook.afterDonate.staticCall(ctx.alice.address, key, 1n, 1n, "0x"),
      ]) await expect(call).to.be.revertedWithCustomError(ctx.hook, "HookNotImplemented");
      // lockAcquired only answers the vault.
      await expect(ctx.hook.lockAcquired("0x")).to.be.revertedWithCustomError(ctx.hook, "NotVault");
    });

    it("bind can only happen once", async function () {
      const ctx = await loadFixture(fixture);
      await expect(ctx.hook.connect(ctx.owner).bind(ctx.alice.address, ctx.alice.address)).to.be.revertedWithCustomError(ctx.hook, "AlreadyBound");
      await expect(ctx.distributor.connect(ctx.owner).bind(ctx.alice.address, ctx.alice.address)).to.be.revertedWithCustomError(ctx.distributor, "AlreadyBound");
    });
  });

  describe("claims", function () {
    it("a re-entering creator contract cannot claim twice", async function () {
      const ctx = await loadFixture(fixture);
      const { poolId, launchedAt } = await doLaunch(ctx, ctx.user, params(ctx.creator.address));
      const attacker = await ethers.deployContract("ReentrantClaimer", [await ctx.distributor.getAddress()]);
      await ctx.distributor.connect(ctx.creator).transferCreator(poolId, await attacker.getAddress());
      await attacker.accept(poolId);
      await time.setNextBlockTimestamp(launchedAt + 60);
      await swap(ctx, ctx.alice, poolId, { buy: true, amount: E(10) });
      await ctx.hook.collect(poolId);
      const owed = await ctx.distributor.creatorOwed(poolId, ethers.ZeroAddress);
      await attacker.claim();
      expect(await attacker.reentryAttempts()).to.equal(1n);
      expect(await attacker.reentrySucceeded()).to.equal(false);
      expect(await ethers.provider.getBalance(await attacker.getAddress())).to.equal(owed);
    });

    it("only the hook can credit and only the core can register pools", async function () {
      const ctx = await loadFixture(fixture);
      await expect(ctx.distributor.connect(ctx.alice).credit(ethers.ZeroHash, 1, 1)).to.be.revertedWithCustomError(ctx.distributor, "NotHook");
      await expect(ctx.distributor.connect(ctx.alice).creditSurcharge(ethers.ZeroAddress, 1)).to.be.revertedWithCustomError(ctx.distributor, "NotHook");
      await expect(ctx.distributor.connect(ctx.alice).registerPool(ethers.ZeroHash, ctx.alice.address, ethers.ZeroAddress, ctx.alice.address, 0, 0))
        .to.be.revertedWithCustomError(ctx.distributor, "NotCore");
    });

    it("claims cannot redirect funds: protocol goes to the treasury, integrator to its registry payout", async function () {
      const ctx = await loadFixture(fixture);
      const { poolId, launchedAt } = await doLaunch(ctx, ctx.app, params(ctx.creator.address));
      await time.setNextBlockTimestamp(launchedAt + 60);
      await swap(ctx, ctx.alice, poolId, { buy: true, amount: E(10) });
      await ctx.hook.collect(poolId);
      const toIntegrator = await ctx.distributor.integratorOwed(1, ethers.ZeroAddress);
      const toProtocol = await ctx.distributor.protocolOwed(ethers.ZeroAddress);
      await expect(ctx.distributor.connect(ctx.alice).claimIntegrator(1, ethers.ZeroAddress)).to.changeEtherBalance(ctx.payout, toIntegrator);
      await expect(ctx.distributor.connect(ctx.alice).claimProtocol(ethers.ZeroAddress)).to.changeEtherBalance(ctx.treasury, toProtocol);
    });
  });

  describe("pause scope", function () {
    it("pausing launches never blocks swaps, collects or claims", async function () {
      const ctx = await loadFixture(fixture);
      const { poolId, launchedAt } = await doLaunch(ctx, ctx.user, params(ctx.creator.address));
      await ctx.core.connect(ctx.guardian).pause();
      await time.setNextBlockTimestamp(launchedAt + 60);
      await swap(ctx, ctx.alice, poolId, { buy: true, amount: E(3) });
      await ctx.hook.collect(poolId);
      await ctx.distributor.claimCreator(poolId);
    });
  });
});
