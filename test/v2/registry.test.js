// Phase 2: IntegratorRegistry — identity (mode A/B), payout, delayed policy, allowlist, signatures.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { DAY, MAX_POLICY, ZERO_POLICY, signIntent } = require("./helpers");

async function fixture() {
  const [owner, guardian, app, appSigner, payout, core, otherCore, creator, attacker, newAccount] = await ethers.getSigners();
  const registry = await ethers.deployContract("IntegratorRegistry", [owner.address, guardian.address]);
  await registry.connect(owner).setCore(core.address, true);
  await registry.connect(app).register("Provenalt", "https://provenalt.example", appSigner.address, payout.address, MAX_POLICY);
  return { owner, guardian, app, appSigner, payout, core, otherCore, creator, attacker, newAccount, registry };
}

async function intentFor(registry, core, overrides = {}) {
  return {
    integratorId: 1,
    core: core.address,
    caller: overrides.caller ?? ethers.Wallet.createRandom().address,
    creator: ethers.Wallet.createRandom().address,
    paramsHash: ethers.id("launch params"),
    nonce: 1n,
    deadline: BigInt((await time.latest()) + 3600),
    ...overrides,
  };
}

describe("v2 phase 2 · IntegratorRegistry", function () {
  describe("registration and identity", function () {
    it("uses msg.sender as the integrator account (mode A identity)", async function () {
      const { registry, app, appSigner, payout } = await loadFixture(fixture);
      expect(await registry.integratorOf(app.address)).to.equal(1n);
      const it_ = await registry.getIntegrator(1);
      expect(it_.account).to.equal(app.address);
      expect(it_.signer).to.equal(appSigner.address);
      expect(await registry.payoutOf(1)).to.equal(payout.address);
      expect(await registry.canLaunch(1)).to.equal(true);
    });

    it("allows one integrator per account and requires a payout and a name", async function () {
      const { registry, app, attacker, payout } = await loadFixture(fixture);
      await expect(registry.connect(app).register("Again", "", ethers.ZeroAddress, payout.address, ZERO_POLICY))
        .to.be.revertedWithCustomError(registry, "AccountAlreadyRegistered");
      await expect(registry.connect(attacker).register("X", "", ethers.ZeroAddress, ethers.ZeroAddress, ZERO_POLICY))
        .to.be.revertedWithCustomError(registry, "ZeroAddress");
      await expect(registry.connect(attacker).register("", "", ethers.ZeroAddress, payout.address, ZERO_POLICY))
        .to.be.revertedWithCustomError(registry, "InvalidProfile");
    });

    it("lets a copycat use the same name but never the same id or account", async function () {
      const { registry, attacker } = await loadFixture(fixture);
      await registry.connect(attacker).register("Provenalt", "", attacker.address, attacker.address, MAX_POLICY);
      expect(await registry.integratorOf(attacker.address)).to.equal(2n);
      expect((await registry.getIntegrator(1)).name).to.equal((await registry.getIntegrator(2)).name);
      expect((await registry.getIntegrator(1)).account).to.not.equal(attacker.address);
    });

    it("moves the account in two steps; only the record's account can change it", async function () {
      const { registry, app, newAccount, attacker } = await loadFixture(fixture);
      await expect(registry.connect(attacker).transferAccount(1, attacker.address)).to.be.revertedWithCustomError(registry, "NotIntegratorAccount");
      await registry.connect(app).transferAccount(1, newAccount.address);
      await expect(registry.connect(attacker).acceptAccount(1)).to.be.revertedWithCustomError(registry, "NotPendingAccount");
      await registry.connect(newAccount).acceptAccount(1);
      expect(await registry.integratorOf(newAccount.address)).to.equal(1n);
      expect(await registry.integratorOf(app.address)).to.equal(0n);
    });

    it("lets the integrator change signer and payout (stored in the registry)", async function () {
      const { registry, app, attacker } = await loadFixture(fixture);
      await registry.connect(app).setPayout(1, attacker.address);
      expect(await registry.payoutOf(1)).to.equal(attacker.address);
      await expect(registry.connect(app).setPayout(1, ethers.ZeroAddress)).to.be.revertedWithCustomError(registry, "ZeroAddress");
      await expect(registry.connect(attacker).setPayout(1, attacker.address)).to.be.revertedWithCustomError(registry, "NotIntegratorAccount");
      await registry.connect(app).setSigner(1, ethers.ZeroAddress);
      expect((await registry.getIntegrator(1)).signer).to.equal(ethers.ZeroAddress);
    });
  });

  describe("policy", function () {
    it("rejects any policy looser than the protocol bounds", async function () {
      const { registry, attacker, payout } = await loadFixture(fixture);
      const bad = [
        { ...ZERO_POLICY, integratorBps: 3001 },
        { ...ZERO_POLICY, maxAllocBps: 2001 },
        { ...ZERO_POLICY, maxDevBuyBps: 1001 },
        { ...ZERO_POLICY, minCliff: 10 * 365 * DAY + 1 },
        { ...ZERO_POLICY, minDuration: 10 * 365 * DAY + 1 },
        { ...ZERO_POLICY, devBuyLock: 10 * 365 * DAY + 1 },
      ];
      for (const p of bad) {
        await expect(registry.connect(attacker).register("A", "", attacker.address, payout.address, p))
          .to.be.revertedWithCustomError(registry, "InvalidPolicy");
      }
    });

    it("applies a queued policy only after 24 hours, for launches made after that", async function () {
      const { registry, app } = await loadFixture(fixture);
      const stricter = { ...MAX_POLICY, integratorBps: 1000, minDuration: 180 * DAY };
      await registry.connect(app).queuePolicy(1, stricter);
      expect((await registry.policyOf(1)).integratorBps).to.equal(3000n);
      await time.increase(24 * 60 * 60 - 2);
      expect((await registry.policyOf(1)).integratorBps).to.equal(3000n);
      await time.increase(2);
      const p = await registry.policyOf(1);
      expect(p.integratorBps).to.equal(1000n);
      expect(p.minDuration).to.equal(BigInt(180 * DAY));
    });

    it("re-queueing restarts the delay and keeps an already-effective policy", async function () {
      const { registry, app } = await loadFixture(fixture);
      await registry.connect(app).queuePolicy(1, { ...MAX_POLICY, integratorBps: 1000 });
      await time.increase(DAY);
      await registry.connect(app).queuePolicy(1, { ...MAX_POLICY, integratorBps: 500 });
      expect((await registry.policyOf(1)).integratorBps).to.equal(1000n); // first one became effective
      await time.increase(DAY);
      expect((await registry.policyOf(1)).integratorBps).to.equal(500n);
    });
  });

  describe("allowlist, suspension, pause", function () {
    it("with the allowlist on, new integrators start unapproved; existing ones keep working", async function () {
      const { registry, owner, attacker, payout } = await loadFixture(fixture);
      await registry.connect(owner).setAllowlistEnabled(true);
      expect(await registry.canLaunch(1)).to.equal(true); // registered while allowlist was off
      await registry.connect(attacker).register("New", "", attacker.address, payout.address, ZERO_POLICY);
      expect(await registry.canLaunch(2)).to.equal(false);
      await registry.connect(owner).setApproved(2, true);
      expect(await registry.canLaunch(2)).to.equal(true);
      await registry.connect(owner).setAllowlistEnabled(false);
      await registry.connect(owner).setApproved(2, false);
      expect(await registry.canLaunch(2)).to.equal(true); // approval only matters while the allowlist is on
    });

    it("suspension and self-deactivation stop new attributions", async function () {
      const { registry, owner, app } = await loadFixture(fixture);
      await registry.connect(owner).setSuspended(1, true);
      expect(await registry.canLaunch(1)).to.equal(false);
      await registry.connect(owner).setSuspended(1, false);
      await registry.connect(app).setSelfActive(1, false);
      expect(await registry.canLaunch(1)).to.equal(false);
    });

    it("guardian can pause registration; only the owner can unpause", async function () {
      const { registry, owner, guardian, attacker, payout } = await loadFixture(fixture);
      await expect(registry.connect(attacker).pauseRegistration()).to.be.revertedWithCustomError(registry, "NotGuardian");
      await registry.connect(guardian).pauseRegistration();
      await expect(registry.connect(attacker).register("A", "", attacker.address, payout.address, ZERO_POLICY))
        .to.be.revertedWithCustomError(registry, "RegistrationPaused");
      await expect(registry.connect(guardian).unpauseRegistration()).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
      await registry.connect(owner).unpauseRegistration();
    });

    it("owner-only switches", async function () {
      const { registry, attacker } = await loadFixture(fixture);
      for (const call of [
        registry.connect(attacker).setAllowlistEnabled(true),
        registry.connect(attacker).setApproved(1, true),
        registry.connect(attacker).setVerified(1, true),
        registry.connect(attacker).setSuspended(1, true),
        registry.connect(attacker).setCore(attacker.address, true),
      ]) await expect(call).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });
  });

  describe("mode B signatures", function () {
    it("accepts a valid EOA signature once and returns the effective policy", async function () {
      const { registry, appSigner, core } = await loadFixture(fixture);
      const intent = await intentFor(registry, core);
      const sig = await signIntent(appSigner, registry, intent);
      await expect(registry.connect(core).consumeIntent(intent, sig)).to.emit(registry, "IntentConsumed");
      expect(await registry.nonceUsed(1, intent.nonce)).to.equal(true);
      await expect(registry.connect(core).consumeIntent(intent, sig)).to.be.revertedWithCustomError(registry, "NonceAlreadyUsed");
    });

    it("accepts nonces in any order", async function () {
      const { registry, appSigner, core } = await loadFixture(fixture);
      for (const nonce of [7n, 3n, 99n]) {
        const intent = await intentFor(registry, core, { nonce });
        await registry.connect(core).consumeIntent(intent, await signIntent(appSigner, registry, intent));
      }
    });

    it("accepts an ERC-1271 smart-wallet signer", async function () {
      const { registry, app, appSigner, core } = await loadFixture(fixture);
      const wallet = await ethers.deployContract("MockERC1271Wallet", [appSigner.address]);
      await registry.connect(app).setSigner(1, await wallet.getAddress());
      const intent = await intentFor(registry, core);
      await registry.connect(core).consumeIntent(intent, await signIntent(appSigner, registry, intent));
    });

    it("rejects tampered fields: caller, creator, params, deadline", async function () {
      const { registry, appSigner, core, attacker } = await loadFixture(fixture);
      const intent = await intentFor(registry, core);
      const sig = await signIntent(appSigner, registry, intent);
      for (const tampered of [
        { ...intent, caller: attacker.address },
        { ...intent, creator: attacker.address },
        { ...intent, paramsHash: ethers.id("other params") },
        { ...intent, deadline: intent.deadline + 1n },
      ]) {
        await expect(registry.connect(core).consumeIntent(tampered, sig)).to.be.revertedWithCustomError(registry, "InvalidSignature");
      }
    });

    it("rejects a signature from anyone but the registered signer", async function () {
      const { registry, core, attacker } = await loadFixture(fixture);
      const intent = await intentFor(registry, core);
      await expect(registry.connect(core).consumeIntent(intent, await signIntent(attacker, registry, intent)))
        .to.be.revertedWithCustomError(registry, "InvalidSignature");
    });

    it("rejects a signature made for another chain", async function () {
      const { registry, appSigner, core } = await loadFixture(fixture);
      const intent = await intentFor(registry, core);
      const sig = await signIntent(appSigner, registry, intent, 1n);
      await expect(registry.connect(core).consumeIntent(intent, sig)).to.be.revertedWithCustomError(registry, "InvalidSignature");
    });

    it("binds the signature to one core and only authorised cores can consume nonces", async function () {
      const { registry, owner, appSigner, core, otherCore, attacker } = await loadFixture(fixture);
      const intent = await intentFor(registry, core);
      const sig = await signIntent(appSigner, registry, intent);
      await expect(registry.connect(attacker).consumeIntent(intent, sig)).to.be.revertedWithCustomError(registry, "NotCore");
      await registry.connect(owner).setCore(otherCore.address, true);
      await expect(registry.connect(otherCore).consumeIntent(intent, sig)).to.be.revertedWithCustomError(registry, "WrongCore");
      expect(await registry.nonceUsed(1, intent.nonce)).to.equal(false);
    });

    it("rejects expired intents, disabled signers and integrators that cannot launch", async function () {
      const { registry, owner, app, appSigner, core } = await loadFixture(fixture);
      const expired = await intentFor(registry, core, { deadline: BigInt(await time.latest()) - 1n });
      await expect(registry.connect(core).consumeIntent(expired, await signIntent(appSigner, registry, expired)))
        .to.be.revertedWithCustomError(registry, "IntentExpired");

      const intent = await intentFor(registry, core);
      const sig = await signIntent(appSigner, registry, intent);
      await registry.connect(owner).setSuspended(1, true);
      await expect(registry.connect(core).consumeIntent(intent, sig)).to.be.revertedWithCustomError(registry, "IntegratorCannotLaunch");
      await registry.connect(owner).setSuspended(1, false);
      await registry.connect(app).setSigner(1, ethers.ZeroAddress);
      await expect(registry.connect(core).consumeIntent(intent, sig)).to.be.revertedWithCustomError(registry, "InvalidSignature");
    });
  });
});
