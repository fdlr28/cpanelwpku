// Third-party integrator, mode A: "Agora" deploys its own router (any HypelysRouter-like contract works),
// which registers itself in the IntegratorRegistry. Launches it forwards are attributed to Agora on-chain.
//   npx hardhat run examples/agora-mode-a.js
const hre = require("hardhat");
const { localStack } = require("./setup");
const { deployAppRouter } = require("../scripts/lib/eridanos");
const sdk = require("../sdk/eridanos-sdk.js");

async function main() {
  const { ethers } = hre;
  const stack = await localStack();
  const [, , , agora, agoraPayout, user] = await ethers.getSigners();

  const router = await deployAppRouter(hre, stack, {
    deployer: agora, owner: agora.address, name: "Agora", uri: "https://agoradex.example",
    signer: ethers.ZeroAddress, payout: agoraPayout.address,
    policy: { integratorBps: 1500, maxAllocBps: 1000, maxDevBuyBps: 500, minCliff: 0, minDuration: 30 * 86400, devBuyLock: 0 },
  });
  const id = await router.integratorId();
  console.log(`Agora registered as integrator #${id} (account = router ${await router.getAddress()})`);

  const p = sdk.normalizeParams({ name: "Agora Cat", symbol: "ACAT", metadataURI: "ipfs://demo", creator: user.address, presetId: 1 });
  const rc = await (await router.connect(user).launch(p)).wait();
  const ev = rc.logs.map((l) => { try { return stack.core.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
  console.log(`Launched ${ev.args.token}: integratorId=${ev.args.integratorId}, attribution=${ev.args.record.attribution} (1 = caller)`);
  for (const line of sdk.describeSupply(ev.args.record)) console.log("  " + line);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
