// Phase 1 foundation on PancakeSwap Infinity (docs/desain/03-rencana-kerja.md):
//   a local test can create a CL pool with a dummy hook on a CL pool manager whose address is supplied at
//   deploy time — never hard-coded — and the hook bitmap in PoolKey.parameters must match the hook.
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
  ADDRESS_ZERO, DYNAMIC_FEE_FLAG, Q96, TICK_SPACING, CURVE_HOOK_BITMAP, clParameters, deployInfinity, sortCurrencies,
} = require("../../scripts/lib/infinity");

function poolKey(hook, pm, quote, token, parameters = clParameters(CURVE_HOOK_BITMAP)) {
  const [currency0, currency1] = sortCurrencies(quote, token);
  return { currency0, currency1, hooks: hook, poolManager: pm, fee: DYNAMIC_FEE_FLAG, parameters };
}

async function fixture() {
  const [deployer, other] = await ethers.getSigners();
  // Two independent Infinity deployments: nothing in our code may assume a particular address.
  const a = await deployInfinity(hre, deployer);
  const b = await deployInfinity(hre, deployer);
  const token = ethers.Wallet.createRandom().address; // any non-zero currency address sorts after native
  return { deployer, other, vaultA: a.vault, pmA: a.poolManager, vaultB: b.vault, pmB: b.poolManager, token };
}

async function dummyHook(pm) {
  return ethers.deployContract("DummyCurveHook", [await pm.getAddress()]);
}

describe("v2 foundation (phase 1, PancakeSwap Infinity)", function () {
  describe("vault and CL pool manager", function () {
    it("wire up: the pool manager is a registered vault app and points at its vault", async function () {
      const { vaultA, pmA, deployer } = await loadFixture(fixture);
      expect(await vaultA.isAppRegistered(await pmA.getAddress())).to.equal(true);
      expect(await pmA.vault()).to.equal(await vaultA.getAddress());
      expect(await vaultA.owner()).to.equal(deployer.address);
      expect(await pmA.owner()).to.equal(deployer.address);
    });

    it("start without a protocol fee controller (no protocol fee on our pools)", async function () {
      const { pmA } = await loadFixture(fixture);
      expect(await pmA.protocolFeeController()).to.equal(ADDRESS_ZERO);
    });

    it("only the owner can register apps on the vault", async function () {
      const { vaultA, other } = await loadFixture(fixture);
      await expect(vaultA.connect(other).registerApp(other.address)).to.be.reverted;
    });
  });

  describe("hook registration bitmap", function () {
    it("CurveHook's bitmap is exactly its six callbacks, and the JS helper agrees", async function () {
      const { pmA } = await loadFixture(fixture);
      const hook = await dummyHook(pmA);
      expect(await hook.getHooksRegistrationBitmap()).to.equal(BigInt(CURVE_HOOK_BITMAP));
      expect(CURVE_HOOK_BITMAP).to.equal(0x0cc5); // before{Initialize,AddLiquidity,Swap}, afterSwap, both returnsDelta
    });

    it("refuses a pool whose parameters carry a different bitmap than the hook reports", async function () {
      const { pmA, token } = await loadFixture(fixture);
      const hook = await dummyHook(pmA);
      const wrong = clParameters(CURVE_HOOK_BITMAP & ~1); // drop beforeInitialize
      await expect(pmA.initialize(poolKey(await hook.getAddress(), await pmA.getAddress(), ADDRESS_ZERO, token, wrong), Q96)).to.be.reverted;
    });
  });

  describe("pool creation", function () {
    it("creates a dynamic-fee native-HYPE pool with the hook on each pool manager", async function () {
      const { pmA, pmB, token } = await loadFixture(fixture);
      for (const pm of [pmA, pmB]) {
        const hook = await dummyHook(pm);
        const key = poolKey(await hook.getAddress(), await pm.getAddress(), ADDRESS_ZERO, token);
        expect(key.currency0).to.equal(ADDRESS_ZERO);
        const rc = await (await pm.initialize(key, Q96)).wait();
        const init = rc.logs.map((l) => { try { return pm.interface.parseLog(l); } catch { return null; } })
          .find((e) => e && e.name === "Initialize");
        expect(init.args.hooks).to.equal(await hook.getAddress());
        expect(init.args.fee).to.equal(DYNAMIC_FEE_FLAG);
        expect(init.args.parameters).to.equal(clParameters(CURVE_HOOK_BITMAP, TICK_SPACING));
        expect(init.args.currency0).to.equal(ADDRESS_ZERO);
        expect(await hook.beforeInitializeCalls()).to.equal(1n);
      }
    });

    it("cannot be used through a pool manager it was not deployed for", async function () {
      const { pmA, pmB, token } = await loadFixture(fixture);
      const hook = await dummyHook(pmA);
      // pmB calls the hook's beforeInitialize, which only accepts pmA.
      await expect(pmB.initialize(poolKey(await hook.getAddress(), await pmB.getAddress(), ADDRESS_ZERO, token), Q96)).to.be.reverted;
    });

    it("refuses a key naming another pool manager", async function () {
      const { pmA, pmB, token } = await loadFixture(fixture);
      const hook = await dummyHook(pmA);
      await expect(pmA.initialize(poolKey(await hook.getAddress(), await pmB.getAddress(), ADDRESS_ZERO, token), Q96)).to.be.reverted;
    });

    it("rejects a second initialization of the same pool", async function () {
      const { pmA, token } = await loadFixture(fixture);
      const hook = await dummyHook(pmA);
      const key = poolKey(await hook.getAddress(), await pmA.getAddress(), ADDRESS_ZERO, token);
      await (await pmA.initialize(key, Q96)).wait();
      await expect(pmA.initialize(key, Q96)).to.be.reverted;
    });
  });
});
