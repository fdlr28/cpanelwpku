// Third-party integrator, mode B: no contract. Agora registers an account + signer; its backend signs an
// EIP-712 LaunchIntent for the exact parameters; the user calls LaunchCore.launchSigned directly.
//   npx hardhat run examples/agora-mode-b.js
const hre = require("hardhat");
const { localStack } = require("./setup");
const sdk = require("../sdk/eridanos-sdk.js");

async function main() {
  const { ethers } = hre;
  const stack = await localStack();
  const [, , , agora, agoraSigner, agoraPayout, user] = await ethers.getSigners();

  await (await stack.registry.connect(agora).register("Agora", "https://agoradex.example", agoraSigner.address, agoraPayout.address,
    { integratorBps: 1500, maxAllocBps: 2000, maxDevBuyBps: 1000, minCliff: 0, minDuration: 0, devBuyLock: 0 })).wait();
  const id = await stack.registry.integratorOf(agora.address);
  console.log(`Agora registered as integrator #${id}, signer ${agoraSigner.address}`);

  // --- backend: build params for the user and sign them ---
  const params = sdk.normalizeParams({ name: "Signed Cat", symbol: "SCAT", metadataURI: "ipfs://demo", creator: user.address, presetId: 1 });
  const intent = {
    integratorId: Number(id),
    core: await stack.core.getAddress(),
    caller: user.address,
    creator: user.address,
    paramsHash: sdk.hashLaunchParams(params),
    nonce: BigInt(ethers.hexlify(ethers.randomBytes(16))),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
  };
  const ctx = { registry: await stack.registry.getAddress(), chainId: (await ethers.provider.getNetwork()).chainId };
  const signature = await sdk.signLaunchIntent(agoraSigner, ctx, intent);

  // --- user: launches directly, no Agora contract involved ---
  const rc = await (await stack.core.connect(user).launchSigned(params, intent, signature)).wait();
  const ev = rc.logs.map((l) => { try { return stack.core.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
  console.log(`Launched ${ev.args.token}: integratorId=${ev.args.integratorId}, attribution=${ev.args.record.attribution} (2 = signed), caller=${ev.args.record.caller}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
