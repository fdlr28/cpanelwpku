const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const UniswapV2Factory = require("@uniswap/v2-core/build/UniswapV2Factory.json");
const UniswapV2Pair = require("@uniswap/v2-core/build/UniswapV2Pair.json");
const UniswapV2Router02 = require("@uniswap/v2-periphery/build/UniswapV2Router02.json");

const E = (n) => ethers.parseEther(String(n));
const DEAD = "0x000000000000000000000000000000000000dEaD";

// Default curve: 1B supply, 800M sold on the curve, 200M (minus graduation fee share) to the LP.
// virtualToken = S^2 / (2S - N) makes the LP listing price equal to the final curve price.
const CURVE = {
  totalSupply: E(1_000_000_000),
  curveSupply: E(800_000_000),
  virtualNative: E(100),
  virtualToken: E(1_066_666_666),
};

async function deployFixture() {
  const [owner, creator, alice, bob, feeRecipient] = await ethers.getSigners();

  const WHYPE = await ethers.deployContract("WrappedNative");
  const Factory = new ethers.ContractFactory(UniswapV2Factory.abi, UniswapV2Factory.bytecode, owner);
  const factory = await Factory.deploy(owner.address);

  const launchpad = await ethers.deployContract("ElysiumLaunchpad", [
    owner.address,
    await factory.getAddress(),
    await WHYPE.getAddress(),
    feeRecipient.address,
    CURVE,
  ]);

  return { owner, creator, alice, bob, feeRecipient, WHYPE, factory, launchpad };
}

async function createToken(launchpad, signer, value = 0n, minOut = 0n) {
  const tx = await launchpad.connect(signer).createToken("Kitty", "KITTY", "ipfs://meta", minOut, { value });
  const rc = await tx.wait();
  const ev = rc.logs.map((l) => launchpad.interface.parseLog(l)).find((e) => e && e.name === "TokenCreated");
  const token = await ethers.getContractAt("LaunchToken", ev.args.token);
  return { token, pair: ev.args.pair, rc };
}

async function fixtureWithToken() {
  const ctx = await deployFixture();
  const { token, pair } = await createToken(ctx.launchpad, ctx.creator);
  return { ...ctx, token, pairAddr: pair };
}

describe("ElysiumLaunchpad", function () {
  describe("config", function () {
    it("accepts the curve produced by scripts/curve.js", async function () {
      const { owner, launchpad } = await loadFixture(deployFixture);
      const { buildCurve } = require("../scripts/curve");
      for (const virtualNative of ["1", "100", "12345"]) {
        await launchpad.connect(owner).setCurveConfig(buildCurve({ virtualNative }));
      }
      await launchpad.connect(owner).setCurveConfig(buildCurve({ curveSupply: "700000000" }));
    });

    it("rejects a curve whose LP listing would be below the final curve price", async function () {
      const { owner, launchpad } = await loadFixture(deployFixture);
      await expect(
        launchpad.connect(owner).setCurveConfig({ ...CURVE, virtualToken: E(2_000_000_000) })
      ).to.be.revertedWithCustomError(launchpad, "InvalidConfig");
    });

    it("caps fees and is owner-only", async function () {
      const { owner, alice, launchpad } = await loadFixture(deployFixture);
      await expect(launchpad.connect(owner).setFees(501, 0, 0, 0)).to.be.revertedWithCustomError(
        launchpad,
        "InvalidConfig"
      );
      await expect(launchpad.connect(alice).setFees(100, 0, 0, 0)).to.be.revertedWithCustomError(
        launchpad,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("createToken", function () {
    it("deploys the token, holds full supply and registers the pair", async function () {
      const { launchpad, factory, WHYPE, creator } = await loadFixture(deployFixture);
      const { token, pair } = await createToken(launchpad, creator);

      expect(await token.totalSupply()).to.equal(CURVE.totalSupply);
      expect(await token.balanceOf(await launchpad.getAddress())).to.equal(CURVE.totalSupply);
      expect(await token.creator()).to.equal(creator.address);
      expect(await token.metadataURI()).to.equal("ipfs://meta");
      expect(await token.pair()).to.equal(pair);
      expect(await factory.getPair(await token.getAddress(), await WHYPE.getAddress())).to.equal(pair);
      expect(await launchpad.allTokensLength()).to.equal(1);
      expect(await launchpad.getTokens(0, 10)).to.deep.equal([await token.getAddress()]);

      const pool = await launchpad.getPool(await token.getAddress());
      expect(pool.creator).to.equal(creator.address);
      expect(pool.virtualNative).to.equal(CURVE.virtualNative);
      expect(pool.virtualToken).to.equal(CURVE.virtualToken);
    });

    it("validates metadata", async function () {
      const { launchpad, creator } = await loadFixture(deployFixture);
      await expect(launchpad.connect(creator).createToken("", "X", "", 0)).to.be.revertedWithCustomError(
        launchpad,
        "InvalidMetadata"
      );
      await expect(
        launchpad.connect(creator).createToken("Name", "WAYTOOLONGSYMBOL", "", 0)
      ).to.be.revertedWithCustomError(launchpad, "InvalidMetadata");
    });

    it("charges the creation fee and supports a creator buy", async function () {
      const { owner, launchpad, creator } = await loadFixture(deployFixture);
      await launchpad.connect(owner).setFees(100, 2500, 0, E(0.1));
      await expect(launchpad.connect(creator).createToken("A", "A", "", 0, { value: E(0.05) })).to.be.revertedWithCustomError(
        launchpad,
        "InsufficientFee"
      );

      const { token } = await createToken(launchpad, creator, E(1.1));
      expect(await token.balanceOf(creator.address)).to.be.gt(0);
      // 0.1 creation fee + 75% of the 1% fee on 1 HYPE
      expect(await launchpad.protocolFeesAccrued()).to.equal(E(0.1) + E(0.0075));
      expect(await launchpad.creatorFeesAccrued(creator.address)).to.equal(E(0.0025));
    });

    it("survives a front-run pair creation", async function () {
      const { launchpad, factory, WHYPE, creator, alice } = await loadFixture(deployFixture);
      const lpAddr = await launchpad.getAddress();
      const nonce = await ethers.provider.getTransactionCount(lpAddr);
      const predicted = ethers.getCreateAddress({ from: lpAddr, nonce });
      await factory.connect(alice).createPair(predicted, await WHYPE.getAddress());

      const { token, pair } = await createToken(launchpad, creator);
      expect(await token.getAddress()).to.equal(predicted);
      expect(pair).to.equal(await factory.getPair(predicted, await WHYPE.getAddress()));
    });
  });

  describe("trading", function () {
    it("buys according to the quote and splits the fee", async function () {
      const { launchpad, token, alice, creator } = await loadFixture(fixtureWithToken);
      const addr = await token.getAddress();
      const [quoteOut, quoteFee, spent, refund] = await launchpad.quoteBuy(addr, E(10));
      expect(quoteFee).to.equal(E(0.1));
      expect(spent).to.equal(E(10));
      expect(refund).to.equal(0);

      await expect(launchpad.connect(alice).buy(addr, quoteOut, { value: E(10) })).to.emit(launchpad, "Trade");
      expect(await token.balanceOf(alice.address)).to.equal(quoteOut);

      // x*y=k with virtual reserves: out = vT * net / (vN + net)
      const net = E(9.9);
      expect(quoteOut).to.equal((CURVE.virtualToken * net) / (CURVE.virtualNative + net));
      expect(await launchpad.creatorFeesAccrued(creator.address)).to.equal(E(0.025));
      expect(await launchpad.protocolFeesAccrued()).to.equal(E(0.075));
    });

    it("enforces buy slippage", async function () {
      const { launchpad, token, alice } = await loadFixture(fixtureWithToken);
      const addr = await token.getAddress();
      const [out] = await launchpad.quoteBuy(addr, E(1));
      await expect(launchpad.connect(alice).buy(addr, out + 1n, { value: E(1) })).to.be.revertedWithCustomError(
        launchpad,
        "Slippage"
      );
    });

    it("sells without an approval and pays out net of fee", async function () {
      const { launchpad, token, alice } = await loadFixture(fixtureWithToken);
      const addr = await token.getAddress();
      await launchpad.connect(alice).buy(addr, 0, { value: E(10) });
      const bal = await token.balanceOf(alice.address);

      const [nativeOut, fee] = await launchpad.quoteSell(addr, bal);
      const before = await ethers.provider.getBalance(alice.address);
      const tx = await launchpad.connect(alice).sell(addr, bal, nativeOut);
      const rc = await tx.wait();
      const gas = rc.gasUsed * rc.gasPrice;
      const after = await ethers.provider.getBalance(alice.address);

      expect(after - before + gas).to.equal(nativeOut);
      expect(await token.balanceOf(alice.address)).to.equal(0);
      // Round trip loses ~2% (1% each way) and nothing more.
      expect(nativeOut).to.be.closeTo(E(9.801), E(0.001));
      expect(fee).to.be.gt(0);
      const pool = await launchpad.getPool(addr);
      expect(pool.tokensSold).to.equal(0);
    });

    it("enforces sell slippage", async function () {
      const { launchpad, token, alice } = await loadFixture(fixtureWithToken);
      const addr = await token.getAddress();
      await launchpad.connect(alice).buy(addr, 0, { value: E(1) });
      const bal = await token.balanceOf(alice.address);
      const [nativeOut] = await launchpad.quoteSell(addr, bal);
      await expect(launchpad.connect(alice).sell(addr, bal, nativeOut + 1n)).to.be.revertedWithCustomError(
        launchpad,
        "Slippage"
      );
    });

    it("price increases with buys", async function () {
      const { launchpad, token, alice } = await loadFixture(fixtureWithToken);
      const addr = await token.getAddress();
      const p0 = await launchpad.currentPrice(addr);
      await launchpad.connect(alice).buy(addr, 0, { value: E(50) });
      const p1 = await launchpad.currentPrice(addr);
      expect(p1).to.be.gt(p0);
      expect(await launchpad.progressBps(addr)).to.be.gt(0);
    });

    it("blocks transfers to the pair before graduation but allows normal transfers", async function () {
      const { launchpad, token, alice, bob, pairAddr } = await loadFixture(fixtureWithToken);
      const addr = await token.getAddress();
      await launchpad.connect(alice).buy(addr, 0, { value: E(1) });
      await expect(token.connect(alice).transfer(pairAddr, 1)).to.be.revertedWithCustomError(
        token,
        "TransferToPairBeforeGraduation"
      );
      await token.connect(alice).transfer(bob.address, 1);
      expect(await token.balanceOf(bob.address)).to.equal(1);
    });

    it("pause blocks buys and creation but never sells", async function () {
      const { owner, launchpad, token, alice, creator } = await loadFixture(fixtureWithToken);
      const addr = await token.getAddress();
      await launchpad.connect(alice).buy(addr, 0, { value: E(1) });
      await launchpad.connect(owner).setPaused(true);
      await expect(launchpad.connect(alice).buy(addr, 0, { value: E(1) })).to.be.revertedWithCustomError(
        launchpad,
        "Paused"
      );
      await expect(launchpad.connect(creator).createToken("B", "B", "", 0)).to.be.revertedWithCustomError(
        launchpad,
        "Paused"
      );
      const bal = await token.balanceOf(alice.address);
      await launchpad.connect(alice).sell(addr, bal, 0);
    });
  });

  describe("graduation", function () {
    async function graduate(ctx, buyer, value) {
      const addr = await ctx.token.getAddress();
      return launchpad(ctx).connect(buyer).buy(addr, 0, { value });
    }
    const launchpad = (ctx) => ctx.launchpad;

    it("caps the final buy, refunds excess and seeds the DEX at the curve price", async function () {
      const ctx = await loadFixture(fixtureWithToken);
      const { token, alice, pairAddr, WHYPE } = ctx;
      const addr = await token.getAddress();

      const needed = await ctx.launchpad.nativeToGraduate(addr);
      // vN_end = vN0 * vT0 / (vT0 - S) => raised = 300 HYPE for the default curve, ~303 incl. fee
      expect(needed).to.be.closeTo(E(303.0303), E(0.01));

      const [, , spent, refund] = await ctx.launchpad.quoteBuy(addr, E(500));
      expect(spent).to.equal(needed);
      expect(refund).to.equal(E(500) - needed);

      const priceBefore = await ctx.launchpad.currentPrice(addr);
      const balBefore = await ethers.provider.getBalance(alice.address);
      const tx = await graduate(ctx, alice, E(500));
      const rc = await tx.wait();
      const balAfter = await ethers.provider.getBalance(alice.address);
      expect(balBefore - balAfter - rc.gasUsed * rc.gasPrice).to.equal(needed);
      await expect(tx).to.emit(ctx.launchpad, "Graduated");

      const pool = await ctx.launchpad.getPool(addr);
      expect(pool.graduated).to.equal(true);
      expect(pool.tokensSold).to.equal(CURVE.curveSupply);
      expect(await token.balanceOf(alice.address)).to.equal(CURVE.curveSupply);
      expect(await token.graduated()).to.equal(true);

      const pair = new ethers.Contract(pairAddr, UniswapV2Pair.abi, ethers.provider);
      const [r0, r1] = await pair.getReserves();
      const t0 = await pair.token0();
      const [tokenRes, nativeRes] = t0 === addr ? [r0, r1] : [r1, r0];
      expect(nativeRes).to.be.closeTo(E(300), E(0.001));
      expect(await WHYPE.balanceOf(pairAddr)).to.equal(nativeRes);

      // DEX price equals final curve price (within rounding)
      const finalCurvePrice = await ctx.launchpad.currentPrice(addr);
      const dexPrice = (nativeRes * E(1)) / tokenRes;
      expect(dexPrice).to.be.closeTo(finalCurvePrice, finalCurvePrice / 1_000_000n);
      expect(finalCurvePrice).to.be.gt(priceBefore);

      // LP locked, launchpad holds no tokens, supply = sold + LP
      expect(await pair.balanceOf(DEAD)).to.be.gt(0);
      expect(await token.balanceOf(await ctx.launchpad.getAddress())).to.equal(0);
      expect(await token.totalSupply()).to.equal(CURVE.curveSupply + tokenRes);
      expect(await ctx.launchpad.progressBps(addr)).to.equal(10_000);
    });

    it("burns leftover tokens when a graduation fee is charged", async function () {
      const ctx = await loadFixture(deployFixture);
      await ctx.launchpad.connect(ctx.owner).setFees(100, 2500, 500, 0); // 5% graduation fee
      const { token, pair } = await createToken(ctx.launchpad, ctx.creator);
      const addr = await token.getAddress();
      const tx = await ctx.launchpad.connect(ctx.alice).buy(addr, 0, { value: E(400) });
      const rc = await tx.wait();
      const ev = rc.logs.map((l) => ctx.launchpad.interface.parseLog(l)).find((e) => e && e.name === "Graduated");
      expect(ev.args.graduationFee).to.be.closeTo(E(15), E(0.001));
      expect(ev.args.nativeLiquidity).to.be.closeTo(E(285), E(0.001));
      expect(ev.args.tokensBurned).to.be.gt(0);
      expect(await token.totalSupply()).to.equal(CURVE.totalSupply - ev.args.tokensBurned);
      expect(await token.balanceOf(await ctx.launchpad.getAddress())).to.equal(0);
      expect(pair).to.equal(ev.args.pair);
    });

    it("is not blocked by WHYPE donated to and synced in the pair", async function () {
      const ctx = await loadFixture(fixtureWithToken);
      const { token, alice, bob, pairAddr, WHYPE } = ctx;
      const addr = await token.getAddress();

      await WHYPE.connect(bob).deposit({ value: E(5) });
      await WHYPE.connect(bob).transfer(pairAddr, E(5));
      const pair = new ethers.Contract(pairAddr, UniswapV2Pair.abi, bob);
      await pair.sync();

      await ctx.launchpad.connect(alice).buy(addr, 0, { value: E(500) });
      const pool = await ctx.launchpad.getPool(addr);
      expect(pool.graduated).to.equal(true);
      expect(await WHYPE.balanceOf(pairAddr)).to.be.closeTo(E(305), E(0.001));
    });

    it("closes the curve after graduation and unlocks DEX transfers", async function () {
      const ctx = await loadFixture(fixtureWithToken);
      const { token, alice, pairAddr } = ctx;
      const addr = await token.getAddress();
      await ctx.launchpad.connect(alice).buy(addr, 0, { value: E(500) });

      await expect(ctx.launchpad.connect(alice).buy(addr, 0, { value: E(1) })).to.be.revertedWithCustomError(
        ctx.launchpad,
        "AlreadyGraduated"
      );
      await expect(ctx.launchpad.connect(alice).sell(addr, 1, 0)).to.be.revertedWithCustomError(
        ctx.launchpad,
        "AlreadyGraduated"
      );
      await token.connect(alice).transfer(pairAddr, 1); // allowed now
    });
  });

  describe("fees", function () {
    it("lets creator and protocol claim their fees", async function () {
      const { launchpad, token, alice, creator, feeRecipient } = await loadFixture(fixtureWithToken);
      await launchpad.connect(alice).buy(await token.getAddress(), 0, { value: E(100) });

      const c = await launchpad.creatorFeesAccrued(creator.address);
      expect(c).to.equal(E(0.25));
      await expect(launchpad.connect(creator).claimCreatorFees()).to.changeEtherBalances(
        [creator, launchpad],
        [c, -c]
      );
      await expect(launchpad.connect(creator).claimCreatorFees()).to.be.revertedWithCustomError(
        launchpad,
        "NothingToClaim"
      );

      const p = await launchpad.protocolFeesAccrued();
      expect(p).to.equal(E(0.75));
      await expect(launchpad.connect(alice).claimProtocolFees()).to.changeEtherBalances(
        [feeRecipient, launchpad],
        [p, -p]
      );
    });
  });

  describe("solvency", function () {
    it("stays solvent across random buys and sells from many traders", async function () {
      const ctx = await loadFixture(deployFixture);
      const signers = (await ethers.getSigners()).slice(5, 15);
      const tokens = [];
      for (let i = 0; i < 3; i++) tokens.push((await createToken(ctx.launchpad, ctx.creator)).token);

      let seed = 42;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return seed / 2 ** 31;
      };

      for (let i = 0; i < 120; i++) {
        const s = signers[Math.floor(rand() * signers.length)];
        const t = tokens[Math.floor(rand() * tokens.length)];
        const addr = await t.getAddress();
        const pool = await ctx.launchpad.getPool(addr);
        if (pool.graduated) continue;
        const bal = await t.balanceOf(s.address);
        if (rand() < 0.6 || bal === 0n) {
          const value = ethers.parseEther((rand() * 40 + 0.001).toFixed(6));
          await ctx.launchpad.connect(s).buy(addr, 0, { value });
        } else {
          const amount = (bal * BigInt(Math.floor(rand() * 100) + 1)) / 100n;
          await ctx.launchpad.connect(s).sell(addr, amount, 0);
        }

        let owed = await ctx.launchpad.protocolFeesAccrued();
        owed += await ctx.launchpad.creatorFeesAccrued(ctx.creator.address);
        for (const tk of tokens) owed += (await ctx.launchpad.getPool(await tk.getAddress())).realNative;
        const held = await ethers.provider.getBalance(await ctx.launchpad.getAddress());
        expect(held).to.be.gte(owed);
      }

      // Everyone dumps everything back into non-graduated curves: must never revert for lack of HYPE.
      for (const t of tokens) {
        const addr = await t.getAddress();
        if ((await ctx.launchpad.getPool(addr)).graduated) continue;
        for (const s of signers) {
          const bal = await t.balanceOf(s.address);
          if (bal > 0n) await ctx.launchpad.connect(s).sell(addr, bal, 0);
        }
        const pool = await ctx.launchpad.getPool(addr);
        expect(pool.tokensSold).to.equal(0);
        expect(pool.virtualNative).to.be.gte(CURVE.virtualNative);
      }
    });
  });
  describe("after graduation", function () {
    it("trades through the canonical Uniswap V2 Router02 in both directions", async function () {
      const ctx = await loadFixture(fixtureWithToken);
      const { token, alice, bob, owner, factory, WHYPE } = ctx;
      const addr = await token.getAddress();
      const router = await new ethers.ContractFactory(UniswapV2Router02.abi, UniswapV2Router02.bytecode, owner).deploy(
        await factory.getAddress(),
        await WHYPE.getAddress()
      );
      await ctx.launchpad.connect(alice).buy(addr, 0, { value: E(500) });

      const path = [await WHYPE.getAddress(), addr];
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 600;
      const [, out] = await router.getAmountsOut(E(1), path);
      await router.connect(bob).swapExactETHForTokens(out, path, bob.address, deadline, { value: E(1) });
      expect(await token.balanceOf(bob.address)).to.equal(out);

      const bal = await token.balanceOf(bob.address);
      await token.connect(bob).approve(await router.getAddress(), bal);
      const before = await ethers.provider.getBalance(bob.address);
      const tx = await router.connect(bob).swapExactTokensForETH(bal, 0, [addr, await WHYPE.getAddress()], bob.address, deadline);
      const rc = await tx.wait();
      const after = await ethers.provider.getBalance(bob.address);
      expect(after + rc.gasUsed * rc.gasPrice - before).to.be.closeTo(E(0.994), E(0.001)); // 2 x 0.3% LP fee
    });
  });
});
