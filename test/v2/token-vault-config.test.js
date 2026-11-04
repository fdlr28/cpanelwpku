// Phase 2: EridanosToken, VestingVault, ProtocolConfig, Timelock ownership.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { SUPPLY, DAY, HYPE_START_TICK, ASCEND_CURVE } = require("./helpers");

async function fixture() {
  const [admin, treasury, guardian, creator, alice, bob, safe] = await ethers.getSigners();
  const token = await ethers.deployContract("EridanosToken", ["Kitty", "KITTY", "ipfs://meta", admin.address]);
  const vault = await ethers.deployContract("VestingVault");
  const config = await ethers.deployContract("ProtocolConfig", [admin.address, treasury.address, guardian.address]);
  return { admin, treasury, guardian, creator, alice, bob, safe, token, vault, config };
}

async function schedule(vault, token, from, beneficiary, amount, cliff, duration) {
  await token.connect(from).approve(await vault.getAddress(), amount);
  const rc = await (await vault.connect(from).createSchedule(await token.getAddress(), beneficiary, amount, cliff, duration)).wait();
  const ev = rc.logs.map((l) => { try { return vault.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "ScheduleCreated");
  return ev.args.id;
}

describe("v2 phase 2 · token, vault, config", function () {
  describe("EridanosToken", function () {
    it("mints exactly 1e27 once to the recipient and keeps immutable metadata", async function () {
      const { token, admin } = await loadFixture(fixture);
      expect(await token.totalSupply()).to.equal(SUPPLY);
      expect(await token.balanceOf(admin.address)).to.equal(SUPPLY);
      expect(await token.decimals()).to.equal(18n);
      expect(await token.name()).to.equal("Kitty");
      expect(await token.symbol()).to.equal("KITTY");
      expect(await token.metadataURI()).to.equal("ipfs://meta");
      expect(await token.launcher()).to.equal(admin.address);
    });

    it("has no owner, mint, pause, blacklist or metadata setter in its ABI", async function () {
      const { token } = await loadFixture(fixture);
      const names = token.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
      for (const forbidden of ["owner", "mint", "pause", "blacklist", "setMetadataURI", "setName", "transferOwnership", "burn"]) {
        expect(names).to.not.include(forbidden);
      }
    });

    it("transfers exact amounts (no tax), including to any address", async function () {
      const { token, admin, alice } = await loadFixture(fixture);
      await token.connect(admin).transfer(alice.address, 12345n);
      expect(await token.balanceOf(alice.address)).to.equal(12345n);
    });
  });

  describe("VestingVault", function () {
    it("pays nothing before the cliff, then vests linearly from start, then fully", async function () {
      const { token, vault, admin, creator, bob } = await loadFixture(fixture);
      const amount = 1_000_000n * 10n ** 18n;
      const id = await schedule(vault, token, admin, creator.address, amount, 30 * DAY, 365 * DAY);
      const s = await vault.getSchedule(id);

      await expect(vault.release(id)).to.be.revertedWithCustomError(vault, "NothingToRelease");
      await time.increaseTo(Number(s.start) + 30 * DAY - 1);
      expect(await vault.releasable(id)).to.equal(0n);

      await time.increaseTo(Number(s.start) + 30 * DAY);
      expect(await vault.releasable(id)).to.equal((amount * BigInt(30 * DAY)) / BigInt(365 * DAY));

      // Anyone can trigger release; funds only go to the fixed beneficiary.
      await vault.connect(bob).release(id);
      expect(await token.balanceOf(bob.address)).to.equal(0n);
      expect(await token.balanceOf(creator.address)).to.be.gt(0n);

      await time.increaseTo(Number(s.start) + 365 * DAY);
      await vault.release(id);
      expect(await token.balanceOf(creator.address)).to.equal(amount);
      await expect(vault.release(id)).to.be.revertedWithCustomError(vault, "NothingToRelease");
    });

    it("pays an instant allocation (duration 0) inside createSchedule and keeps the record", async function () {
      const { token, vault, admin, creator } = await loadFixture(fixture);
      const amount = 5n * 10n ** 25n;
      await token.connect(admin).approve(await vault.getAddress(), amount);
      await expect(vault.connect(admin).createSchedule(await token.getAddress(), creator.address, amount, 0, 0))
        .to.emit(vault, "ScheduleCreated")
        .and.to.emit(vault, "Released");
      expect(await token.balanceOf(creator.address)).to.equal(amount);
      const s = await vault.getSchedule(1);
      expect(s.duration).to.equal(0n);
      expect(s.released).to.equal(amount);
    });

    it("rejects cliff > duration, zero amount, zero beneficiary and fee-on-transfer tokens", async function () {
      const { token, vault, admin, creator } = await loadFixture(fixture);
      const t = await token.getAddress();
      await token.approve(await vault.getAddress(), SUPPLY);
      await expect(vault.createSchedule(t, creator.address, 1n, 10, 5)).to.be.revertedWithCustomError(vault, "InvalidSchedule");
      await expect(vault.createSchedule(t, creator.address, 0n, 0, 5)).to.be.revertedWithCustomError(vault, "InvalidSchedule");
      await expect(vault.createSchedule(t, ethers.ZeroAddress, 1n, 0, 5)).to.be.revertedWithCustomError(vault, "InvalidSchedule");
      // cliff == duration is allowed (pure cliff)
      await vault.createSchedule(t, creator.address, 1n, 5, 5);

      const fot = await ethers.deployContract("MockFeeOnTransferToken");
      await fot.approve(await vault.getAddress(), 10n ** 20n);
      await expect(vault.createSchedule(await fot.getAddress(), creator.address, 10n ** 20n, 0, 100)).to.be.revertedWithCustomError(vault, "UnsupportedToken");
      void admin;
    });

    it("never vests more than the total and releases exactly the total over random schedules", async function () {
      const { token, vault, admin } = await loadFixture(fixture);
      const signers = (await ethers.getSigners()).slice(7, 12);
      let seed = 7;
      const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
      const ids = [];
      for (let i = 0; i < 10; i++) {
        const duration = rand(400) * DAY + rand(DAY);
        const cliff = duration === 0 ? 0 : rand(duration + 1);
        const amount = BigInt(rand(1_000_000) + 1) * 10n ** 18n + BigInt(rand(1000));
        ids.push({ id: await schedule(vault, token, admin, signers[i % 5].address, amount, cliff, duration), amount, beneficiary: signers[i % 5].address });
      }
      let last = new Map();
      for (let step = 0; step < 25; step++) {
        await time.increase(rand(30 * DAY) + 1);
        for (const { id, amount } of ids) {
          const now = await time.latest();
          const v = await vault.vestedAmount(id, now);
          expect(v).to.be.lte(amount);
          expect(v).to.be.gte(last.get(id) ?? 0n);
          last.set(id, v);
          if ((await vault.releasable(id)) > 0n) await vault.release(id);
        }
      }
      await time.increase(500 * DAY);
      for (const { id, amount } of ids) {
        if ((await vault.releasable(id)) > 0n) await vault.release(id);
        expect((await vault.getSchedule(id)).released).to.equal(amount);
      }
      expect(await token.balanceOf(await vault.getAddress())).to.equal(0n);
    });
  });

  describe("ProtocolConfig", function () {
    it("stores the treasury and guardian and refuses a zero treasury", async function () {
      const { config, treasury, guardian, admin } = await loadFixture(fixture);
      expect(await config.treasury()).to.equal(treasury.address);
      expect(await config.guardian()).to.equal(guardian.address);
      await expect(config.connect(admin).setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(config, "ZeroAddress");
    });

    it("accepts the 15-band Ascend-shaped curve for native HYPE and USDC and stores it append-only", async function () {
      const { config, admin } = await loadFixture(fixture);
      const usdc = ethers.Wallet.createRandom().address;
      await config.connect(admin).setQuote(ethers.ZeroAddress, true);
      await config.connect(admin).setQuote(usdc, true);
      await expect(config.connect(admin).addCurvePreset(ethers.ZeroAddress, HYPE_START_TICK, ASCEND_CURVE)).to.emit(config, "CurvePresetAdded");
      await config.connect(admin).addCurvePreset(usdc, -393800, ASCEND_CURVE);

      const [info, bands] = await config.preset(1);
      expect(info.quote).to.equal(ethers.ZeroAddress);
      expect(info.startTick).to.equal(HYPE_START_TICK);
      expect(info.curveTop).to.equal(200_000);
      expect(bands.length).to.equal(15);
      expect(await config.isPresetUsable(1)).to.equal(true);

      await config.connect(admin).setCurvePresetEnabled(1, false);
      expect(await config.isPresetUsable(1)).to.equal(false);
      await config.connect(admin).setQuote(usdc, false);
      expect(await config.isPresetUsable(2)).to.equal(false);
    });

    it("maps bands to pool ticks for both token orderings", async function () {
      const { config } = await loadFixture(fixture);
      const b = ASCEND_CURVE[0];
      const [lo0, up0] = await config.bandTicks(true, HYPE_START_TICK, b);
      const [lo1, up1] = await config.bandTicks(false, HYPE_START_TICK, b);
      expect([lo0, up0]).to.deep.equal([BigInt(HYPE_START_TICK), BigInt(HYPE_START_TICK + 19_400)]);
      expect([lo1, up1]).to.deep.equal([BigInt(-(HYPE_START_TICK + 19_400)), BigInt(-HYPE_START_TICK)]);
    });

    it("rejects malformed curves", async function () {
      const { config, admin } = await loadFixture(fixture);
      await config.connect(admin).setQuote(ethers.ZeroAddress, true);
      const add = (start, bands) => config.connect(admin).addCurvePreset(ethers.ZeroAddress, start, bands);
      const band = (l, u, bps) => ({ offsetLower: l, offsetUpper: u, bps });

      await expect(add(HYPE_START_TICK, [])).to.be.revertedWithCustomError(config, "InvalidCurve");
      await expect(add(HYPE_START_TICK, [band(0, 200, 9_999)])).to.be.revertedWithCustomError(config, "InvalidCurve"); // bps ≠ 10 000
      await expect(add(HYPE_START_TICK, [band(0, 250, 10_000)])).to.be.revertedWithCustomError(config, "InvalidCurve"); // not on spacing
      await expect(add(HYPE_START_TICK, [band(0, 400, 5_000), band(200, 600, 5_000)])).to.be.revertedWithCustomError(config, "InvalidCurve"); // overlap
      await expect(add(HYPE_START_TICK, [band(200, 200, 10_000)])).to.be.revertedWithCustomError(config, "InvalidCurve"); // empty
      await expect(add(HYPE_START_TICK, [band(0, 200, 0), band(200, 400, 10_000)])).to.be.revertedWithCustomError(config, "InvalidCurve"); // zero bps
      const tooMany = Array.from({ length: 17 }, (_, i) => band(i * 200, (i + 1) * 200, i === 0 ? 10_000 - 16 : 1));
      await expect(add(HYPE_START_TICK, tooMany)).to.be.revertedWithCustomError(config, "InvalidCurve");
      await expect(add(HYPE_START_TICK + 100, ASCEND_CURVE)).to.be.revertedWithCustomError(config, "InvalidStartTick"); // not on spacing
      await expect(add(700_000, ASCEND_CURVE)).to.be.revertedWithCustomError(config, "InvalidStartTick"); // past max usable tick
      await expect(add(-887_200, ASCEND_CURVE)).to.be.revertedWithCustomError(config, "InvalidStartTick"); // no room below the start
    });

    it("rejects curves whose liquidity per tick would exceed the PoolManager cap", async function () {
      const { config, admin } = await loadFixture(fixture);
      await config.connect(admin).setQuote(ethers.ZeroAddress, true);
      // The whole supply in one 200-tick band at a very high price: liquidity explodes.
      await expect(
        config.connect(admin).addCurvePreset(ethers.ZeroAddress, 800_000, [{ offsetLower: 0, offsetUpper: 200, bps: 10_000 }])
      ).to.be.revertedWithCustomError(config, "LiquidityTooHigh");
    });

    it("needs an allowed quote and is owner-only", async function () {
      const { config, admin, alice } = await loadFixture(fixture);
      await expect(config.connect(admin).addCurvePreset(ethers.ZeroAddress, HYPE_START_TICK, ASCEND_CURVE)).to.be.revertedWithCustomError(config, "QuoteNotAllowed");
      await expect(config.connect(alice).setQuote(ethers.ZeroAddress, true)).to.be.revertedWithCustomError(config, "OwnableUnauthorizedAccount");
    });
  });

  describe("Timelock ownership", function () {
    it("only applies admin changes through the timelock after the delay", async function () {
      const { safe, treasury, guardian } = await loadFixture(fixture);
      const timelock = await ethers.deployContract("EridanosTimelock", [3600, [safe.address], [ethers.ZeroAddress], ethers.ZeroAddress]);
      const config = await ethers.deployContract("ProtocolConfig", [await timelock.getAddress(), treasury.address, guardian.address]);

      await expect(config.connect(safe).setQuote(ethers.ZeroAddress, true)).to.be.revertedWithCustomError(config, "OwnableUnauthorizedAccount");

      const data = config.interface.encodeFunctionData("setQuote", [ethers.ZeroAddress, true]);
      const target = await config.getAddress();
      const salt = ethers.id("allow HYPE");
      await timelock.connect(safe).schedule(target, 0, data, ethers.ZeroHash, salt, 3600);
      await expect(timelock.execute(target, 0, data, ethers.ZeroHash, salt)).to.be.reverted; // too early
      await time.increase(3600);
      await timelock.execute(target, 0, data, ethers.ZeroHash, salt); // executor role open to anyone
      expect(await config.isQuoteAllowed(ethers.ZeroAddress)).to.equal(true);
    });
  });
});
