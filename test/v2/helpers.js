// Shared fixtures for the v2 (Eridanos) test suites.
const { ethers } = require("hardhat");

const SUPPLY = 10n ** 27n;
const DAY = 24 * 60 * 60;

// 15-band single-sided curve; shape from the live Ascend testnet curve (MIT-licensed source,
// zynorr/ascendkit packages/core/src/tick.test.ts LIVE_CURVE),
// re-anchored for a HYPE quote at ~30 HYPE initial market cap (canonical tick ≈ log1.0001(3e-8)).
const HYPE_START_TICK = -173200;
const ASCEND_CURVE = [
  [0, 19_400, 3_519],
  [19_400, 20_600, 146],
  [20_600, 21_800, 160],
  [21_800, 23_000, 175],
  [23_000, 40_000, 1_888],
  [40_000, 41_200, 97],
  [41_200, 42_400, 108],
  [42_400, 43_600, 121],
  [43_600, 44_800, 135],
  [44_800, 46_000, 151],
  [46_000, 66_600, 1_853],
  [66_600, 67_800, 70],
  [67_800, 69_000, 77],
  [69_000, 92_000, 1_000],
  [92_000, 200_000, 500],
].map(([offsetLower, offsetUpper, bps]) => ({ offsetLower, offsetUpper, bps }));

const ZERO_POLICY = { integratorBps: 0, maxAllocBps: 0, maxDevBuyBps: 0, minCliff: 0, minDuration: 0, devBuyLock: 0 };
const MAX_POLICY = { integratorBps: 3000, maxAllocBps: 2000, maxDevBuyBps: 1000, minCliff: 0, minDuration: 0, devBuyLock: 0 };

const INTENT_TYPES = {
  LaunchIntent: [
    { name: "integratorId", type: "uint32" },
    { name: "core", type: "address" },
    { name: "caller", type: "address" },
    { name: "creator", type: "address" },
    { name: "paramsHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
};

async function intentDomain(registry, chainId) {
  return {
    name: "Eridanos",
    version: "1",
    chainId: chainId ?? (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await registry.getAddress(),
  };
}

async function signIntent(signer, registry, intent, chainId) {
  return signer.signTypedData(await intentDomain(registry, chainId), INTENT_TYPES, intent);
}

module.exports = { SUPPLY, DAY, HYPE_START_TICK, ASCEND_CURVE, ZERO_POLICY, MAX_POLICY, INTENT_TYPES, intentDomain, signIntent };
