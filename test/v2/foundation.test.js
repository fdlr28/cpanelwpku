// Phase 1 exit criteria (docs/desain/03-rencana-kerja.md):
//   a local test can create a v4 pool with a dummy hook at a mined address, on a PoolManager whose
//   address is supplied at deploy time — never hard-coded.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
  ADDRESS_ZERO,
  DYNAMIC_FEE_FLAG,
  Q96,
  deployPoolManager,
  isCanonicalPoolManager,
  sortCurrencies,
  POOL_MANAGER_ARTIFACT,
} = require("../../scripts/lib/v4");
const { ALL_HOOK_MASK, CURVE_HOOK_FLAGS, mineHookSalt } = require("../../scripts/lib/hookMiner");

const TICK_SPACING = 200;
const pmInterface = new ethers.Interface(POOL_MANAGER_ARTIFACT.abi);

async function deployMinedHook(hookDeployer, poolManagerAddress) {
  const Hook = await ethers.getContractFactory("DummyCurveHook");
  const initCode = ethers.concat([
    Hook.bytecode,
    ethers.AbiCoder.defaultAbiCoder().encode(["address"], [poolManagerAddress]),
  ]);
  const deployerAddress = await hookDeployer.getAddress();
  const { salt, address } = mineHookSalt(deployerAddress, initCode);
  await (await hookDeployer.deploy(salt, initCode)).wait();
  return { hook: Hook.attach(address), salt, address };
}

function poolKey(hookAddress, quote, token) {
  const [currency0, currency1] = sortCurrencies(quote, token);
  return { currency0, currency1, fee: DYNAMIC_FEE_FLAG, tickSpacing: TICK_SPACING, hooks: hookAddress };
}

async function fixture() {
  const [deployer, ownerA, ownerB] = await ethers.getSigners();
  // Two independent PoolManagers: nothing in our code may assume a particular address.
  const pmA = await deployPoolManager(deployer, ownerA.address);
  const pmB = await deployPoolManager(deployer, ownerB.address);
  const hookDeployer = await ethers.deployContract("HookDeployer");
  const token = ethers.Wallet.createRandom().address; // any non-zero currency address sorts after native
  return { deployer, ownerA, ownerB, pmA, pmB, hookDeployer, token };
}

describe("v2 foundation (phase 1)", function () {
  describe("PoolManager", function () {
    it("is deployed from the canonical @uniswap/v4-core artifact, byte-for-byte", async function () {
      const { pmA, pmB, ownerA, ownerB } = await loadFixture(fixture);
      expect(await isCanonicalPoolManager(ethers.provider, await pmA.getAddress())).to.equal(true);
      expect(await isCanonicalPoolManager(ethers.provider, await pmB.getAddress())).to.equal(true);
      expect(await pmA.owner()).to.equal(ownerA.address);
      expect(await pmB.owner()).to.equal(ownerB.address);
    });

    it("lets the owner leave the protocol fee controller unset (no protocol fee on our pools)", async function () {
      const { pmA } = await loadFixture(fixture);
      expect(await pmA.protocolFeeController()).to.equal(ADDRESS_ZERO);
    });
  });

  describe("hook address mining", function () {
    it("places the hook on an address carrying exactly CurveHook's permission bits", async function () {
      const { pmA, hookDeployer } = await loadFixture(fixture);
      const { hook, address } = await deployMinedHook(hookDeployer, await pmA.getAddress());
      expect(BigInt(address) & ALL_HOOK_MASK).to.equal(CURVE_HOOK_FLAGS);
      expect(CURVE_HOOK_FLAGS).to.equal(0x28ccn);
      expect(await hook.poolManager()).to.equal(await pmA.getAddress());
    });

    it("binds the PoolManager at deploy time: a different PoolManager gives a different hook", async function () {
      const { pmA, pmB, hookDeployer } = await loadFixture(fixture);
      const a = await deployMinedHook(hookDeployer, await pmA.getAddress());
      const b = await deployMinedHook(hookDeployer, await pmB.getAddress());
      expect(a.address).to.not.equal(b.address);
      expect(await a.hook.poolManager()).to.equal(await pmA.getAddress());
      expect(await b.hook.poolManager()).to.equal(await pmB.getAddress());
    });

    it("refuses to deploy the hook at an address without the right bits", async function () {
      const { pmA } = await loadFixture(fixture);
      const Hook = await ethers.getContractFactory("DummyCurveHook");
      // Plain CREATE: the address is effectively random, so its low 14 bits almost surely differ.
      await expect(Hook.deploy(await pmA.getAddress())).to.be.reverted;
    });

    it("computes the same address on-chain as the off-chain miner", async function () {
      const { pmA, hookDeployer } = await loadFixture(fixture);
      const Hook = await ethers.getContractFactory("DummyCurveHook");
      const initCode = ethers.concat([
        Hook.bytecode,
        ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await pmA.getAddress()]),
      ]);
      const { salt, address } = mineHookSalt(await hookDeployer.getAddress(), initCode);
      expect(await hookDeployer.computeAddress(salt, ethers.keccak256(initCode))).to.equal(address);
    });
  });

  describe("pool creation", function () {
    it("creates a dynamic-fee native-HYPE pool with the mined hook on each PoolManager", async function () {
      const { pmA, pmB, hookDeployer, token } = await loadFixture(fixture);
      for (const pm of [pmA, pmB]) {
        const { hook, address } = await deployMinedHook(hookDeployer, await pm.getAddress());
        const key = poolKey(address, ADDRESS_ZERO, token);
        expect(key.currency0).to.equal(ADDRESS_ZERO);

        const rc = await (await pm.initialize(key, Q96)).wait();
        const init = rc.logs.map((l) => { try { return pmInterface.parseLog(l); } catch { return null; } })
          .find((e) => e && e.name === "Initialize");
        expect(init.args.hooks).to.equal(address);
        expect(init.args.fee).to.equal(DYNAMIC_FEE_FLAG);
        expect(init.args.tickSpacing).to.equal(TICK_SPACING);
        expect(init.args.currency0).to.equal(ADDRESS_ZERO);
        expect(await hook.beforeInitializeCalls()).to.equal(1n);
      }
    });

    it("cannot be used through a PoolManager it was not deployed for", async function () {
      const { pmA, pmB, hookDeployer, token } = await loadFixture(fixture);
      const { address } = await deployMinedHook(hookDeployer, await pmA.getAddress());
      // pmB calls the hook's beforeInitialize, which only accepts pmA.
      await expect(pmB.initialize(poolKey(address, ADDRESS_ZERO, token), Q96)).to.be.reverted;
    });

    it("rejects a second initialization of the same pool", async function () {
      const { pmA, hookDeployer, token } = await loadFixture(fixture);
      const { address } = await deployMinedHook(hookDeployer, await pmA.getAddress());
      const key = poolKey(address, ADDRESS_ZERO, token);
      await (await pmA.initialize(key, Q96)).wait();
      await expect(pmA.initialize(key, Q96)).to.be.reverted;
    });
  });
});
