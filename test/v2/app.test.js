// Phase 5: Provenalt app layer — HypelysRouter (integrator #1 contract) and the Eridanos SDK.
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const sdk = require("../../sdk/eridanos-sdk.js");
const { deployAppRouter } = require("../../scripts/lib/eridanos");
const { SUPPLY, DAY, MAX_POLICY } = require("./helpers");
const { E, fixture, params, clean, events } = require("./launchFixture");

const PROVENALT_POLICY = { ...MAX_POLICY }; // 30% integrator share, protocol supply bounds

async function appFixture() {
  const ctx = await fixture();
  const [, , , , , , , , , , provenaltOwner, provenaltPayout, agoraOwner] = await ethers.getSigners();
  const router = await deployAppRouter(hre, ctx, {
    deployer: provenaltOwner, owner: provenaltOwner.address, name: "Provenalt", uri: "https://provenalt.example",
    signer: ethers.ZeroAddress, payout: provenaltPayout.address, policy: PROVENALT_POLICY,
  });
  for (const s of [ctx.alice, ctx.bob, ctx.user, ctx.creator]) {
    await ctx.usdc.connect(s).approve(await router.getAddress(), ethers.MaxUint256);
  }
  return { ...ctx, router, provenaltOwner, provenaltPayout, agoraOwner };
}

async function launchVia(ctx, signer, p, value = 0n) {
  const rc = await (await ctx.router.connect(signer).launch(clean(p), { value })).wait();
  const ev = events(ctx, rc, ctx.core, "Launched")[0];
  const block = await ethers.provider.getBlock(rc.blockNumber);
  return { rc, ev, token: await ethers.getContractAt("EridanosToken", ev.args.token), poolId: ev.args.record.poolId, launchedAt: block.timestamp };
}

describe("v2 phase 5 · Provenalt app layer", function () {
  describe("HypelysRouter", function () {
    it("registers itself as an integrator and attributes launches to itself (mode A)", async function () {
      const ctx = await loadFixture(appFixture);
      const id = await ctx.router.integratorId();
      expect(id).to.equal(2n); // #1 is the EOA integrator from the base fixture
      expect(await ctx.registry.integratorOf(await ctx.router.getAddress())).to.equal(id);
      const { ev } = await launchVia(ctx, ctx.user, params(ctx.user.address));
      expect(ev.args.integratorId).to.equal(id);
      expect(ev.args.record.attribution).to.equal(1n);
      expect(ev.args.record.creator).to.equal(ctx.user.address);
      expect(ev.args.record.integratorBps).to.equal(3000n);
    });

    it("the caller is always the creator", async function () {
      const ctx = await loadFixture(appFixture);
      await expect(ctx.router.connect(ctx.user).launch(clean(params(ctx.bob.address)))).to.be.revertedWithCustomError(ctx.router, "CreatorMustBeCaller");
    });

    it("binds the salt to the user: the same salt from two users never collides (no front-run griefing)", async function () {
      const ctx = await loadFixture(appFixture);
      const pa = params(ctx.alice.address, { saltLabel: "same" });
      const pb = params(ctx.bob.address, { saltLabel: "same" });
      const predicted = await ctx.router.predictToken(ctx.alice.address, clean(pa));
      await launchVia(ctx, ctx.bob, pb); // "front-runner" uses the same salt first
      const { token } = await launchVia(ctx, ctx.alice, pa);
      expect(await token.getAddress()).to.equal(predicted);
    });

    it("returns the unspent dev-buy HYPE to the user and leaves nothing in the router", async function () {
      const ctx = await loadFixture(appFixture);
      const p = params(ctx.user.address, { devBuyTokens: SUPPLY / 20n, maxDevBuyQuote: E(300) });
      const before = await ethers.provider.getBalance(ctx.user.address);
      const { rc, ev, token } = await launchVia(ctx, ctx.user, p, E(300));
      const spent = before - (await ethers.provider.getBalance(ctx.user.address)) - rc.gasUsed * rc.gasPrice;
      expect(spent).to.equal(ev.args.record.devBuyQuoteSpent);
      expect(await token.balanceOf(ctx.user.address)).to.equal(SUPPLY / 20n);
      expect(await ethers.provider.getBalance(await ctx.router.getAddress())).to.equal(0n);
    });

    it("handles an ERC-20 quote dev buy (USDC): pulls, spends, refunds", async function () {
      const ctx = await loadFixture(appFixture);
      const p = params(ctx.user.address, { presetId: 2, devBuyTokens: E(2_000_000), maxDevBuyQuote: 10n ** 21n });
      const before = await ctx.usdc.balanceOf(ctx.user.address);
      const { ev } = await launchVia(ctx, ctx.user, p);
      expect(before - (await ctx.usdc.balanceOf(ctx.user.address))).to.equal(ev.args.record.devBuyQuoteSpent);
      expect(await ctx.usdc.balanceOf(await ctx.router.getAddress())).to.equal(0n);
    });

    it("buys and sells with slippage and deadline protection", async function () {
      const ctx = await loadFixture(appFixture);
      const { token, launchedAt } = await launchVia(ctx, ctx.user, params(ctx.user.address));
      const t = await token.getAddress();
      await time.increaseTo(launchedAt + 30); // quote outside the anti-sniper window: the fee depends on time
      const deadline = launchedAt + 600;
      const quotedOut = await ctx.router.connect(ctx.alice).buy.staticCall(t, E(2), 0, deadline, { value: E(2) });
      await expect(ctx.router.connect(ctx.alice).buy(t, E(2), quotedOut + 1n, deadline, { value: E(2) })).to.be.revertedWithCustomError(ctx.router, "Slippage");
      await ctx.router.connect(ctx.alice).buy(t, E(2), (quotedOut * 99n) / 100n, deadline, { value: E(2) });
      const bal = await token.balanceOf(ctx.alice.address);
      expect(bal).to.be.gt(0n);

      await token.connect(ctx.alice).approve(await ctx.router.getAddress(), bal);
      const out = await ctx.router.connect(ctx.alice).sell.staticCall(t, bal / 2n, 0, deadline);
      await expect(ctx.router.connect(ctx.alice).sell(t, bal / 2n, out, deadline)).to.changeEtherBalance(ctx.alice, out);
      await expect(ctx.router.connect(ctx.alice).sell(t, 1n, 0, launchedAt - 1)).to.be.revertedWithCustomError(ctx.router, "Expired");
      await expect(ctx.router.connect(ctx.alice).buy(ctx.alice.address, 1n, 0, deadline, { value: 1n })).to.be.revertedWithCustomError(ctx.router, "UnknownToken");
      await expect(ctx.router.connect(ctx.alice).buy(t, E(1), 0, deadline, { value: E(2) })).to.be.revertedWithCustomError(ctx.router, "WrongValue");
    });

    it("pays the integrator share to the router's payout; only the router owner manages the record", async function () {
      const ctx = await loadFixture(appFixture);
      const { token, poolId, launchedAt } = await launchVia(ctx, ctx.user, params(ctx.user.address));
      await time.setNextBlockTimestamp(launchedAt + 60);
      await ctx.router.connect(ctx.alice).buy(await token.getAddress(), E(10), 0, launchedAt + 600, { value: E(10) });
      await ctx.hook.collect(poolId);
      const id = await ctx.router.integratorId();
      const owed = await ctx.distributor.integratorOwed(id, ethers.ZeroAddress);
      await expect(ctx.distributor.claimIntegrator(id, ethers.ZeroAddress)).to.changeEtherBalance(ctx.provenaltPayout, owed);

      await expect(ctx.router.connect(ctx.alice).setPayout(ctx.alice.address)).to.be.revertedWithCustomError(ctx.router, "OwnableUnauthorizedAccount");
      await ctx.router.connect(ctx.provenaltOwner).queuePolicy({ ...PROVENALT_POLICY, minDuration: 30 * DAY });
      await time.increase(DAY);
      expect((await ctx.registry.policyOf(id)).minDuration).to.equal(BigInt(30 * DAY));
    });
  });

  describe("SDK", function () {
    it("hashes launch params exactly like LaunchCore.hashParams", async function () {
      const ctx = await loadFixture(appFixture);
      const p = clean(params(ctx.user.address, { allocations: [{ recipient: ctx.user.address, bps: 700 }], cliff: 10, duration: 1000, devBuyTokens: 5n, maxDevBuyQuote: 7n }));
      expect(sdk.hashLaunchParams(p)).to.equal(await ctx.core.hashParams(p));
    });

    it("signs a mode-B intent the protocol accepts, and lists launches with disclosures", async function () {
      const ctx = await loadFixture(appFixture);
      const p = sdk.normalizeParams({ name: "Signed", symbol: "SIG", creator: ctx.user.address, presetId: 1, allocations: [{ recipient: ctx.user.address, bps: 2000 }] });
      const intent = {
        integratorId: 1, core: await ctx.core.getAddress(), caller: ctx.user.address, creator: ctx.user.address,
        paramsHash: sdk.hashLaunchParams(p), nonce: 77n, deadline: BigInt((await time.latest()) + 600),
      };
      const signature = await sdk.signLaunchIntent(ctx.appSigner, { registry: await ctx.registry.getAddress(), chainId: (await ethers.provider.getNetwork()).chainId }, intent);
      await ctx.core.connect(ctx.user).launchSigned(p, intent, signature);

      const launches = await sdk.listLaunches(ethers.provider, await ctx.core.getAddress());
      const last = launches[launches.length - 1];
      expect(last.integratorId).to.equal(1);
      expect(Number(last.record.attribution)).to.equal(2);
      const lines = sdk.describeSupply(last.record);
      expect(lines[0]).to.equal("Creator allocation: 20% — UNLOCKED at launch");
    });

    it("computes the same surcharge as the hook", async function () {
      expect(sdk.surchargeExactIn(E(1), 0)).to.equal((E(1) * (900_000n - 10_000n)) / 990_000n);
      expect(sdk.surchargeExactIn(E(1), 10)).to.equal(0n);
      expect(sdk.scheduleFee(5)).to.equal(10_000n + (890_000n * 5n) / 10n);
    });
  });
});
