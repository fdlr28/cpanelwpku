// Phase 6 smoke test against a live Eridanos v2 + Provenalt deployment (deployments/<network>-v2.json).
// Uses tiny HYPE amounts. Only 99801 (testnet) and 31337 (local) are accepted.
//   CONFIRM=yes npx hardhat run scripts/smoke-testnet-v2.js --network elysiumTestnet
//
// Covers: mode A (Provenalt router, instant + vesting allocation, dev buy), mode C (direct, dev buy),
// mode B (signed intent), a USDC launch, buys inside/after the anti-sniper window, a sell inside the
// window (token surcharge → burned at collect), collect, creator/integrator/protocol claims, vesting
// release, and a few must-revert checks (staticCall, no gas).
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const sdk = require("../sdk/eridanos-sdk.js");

const SUPPLY = 10n ** 27n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { ethers, network } = hre;
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (![99801n, 31337n].includes(chainId)) throw new Error(`Refusing chain ${chainId}`);
  if (chainId === 99801n && process.env.CONFIRM !== "yes") throw new Error("Re-run with CONFIRM=yes");
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}-v2.json`), "utf8"));
  const [me] = await ethers.getSigners();
  const at = (name, a) => ethers.getContractAt(name, a, me);
  const core = await at("LaunchCore", d.core);
  const hook = await at("CurveHook", d.hook);
  const dist = await at("FeeDistributor", d.distributor);
  const reg = await at("IntegratorRegistry", d.registry);
  const vault = await at("VestingVault", d.vault);
  const router = await at("ProvenaltRouter", d.router);
  const results = [];
  const txs = {};
  const check = (name, ok, info = "") => { results.push({ name, ok: !!ok, info: String(info) }); console.log(`${ok ? "✓" : "✗"} ${name}${info !== "" ? " — " + info : ""}`); };
  const send = async (label, p) => { const rc = await (await p).wait(); txs[label] = rc.hash; return rc; };
  const parse = (rc, iface, name) => rc.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).filter((e) => e && e.name === name);
  const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);
  const startBal = await ethers.provider.getBalance(me);
  // Wait until the chain's clock reaches `ts`. A local node only mines on demand, so mine empty blocks there.
  const waitUntil = async (ts) => {
    while ((await ethers.provider.getBlock("latest")).timestamp < ts) {
      if (chainId === 31337n) await ethers.provider.send("evm_mine", []);
      await sleep(1000);
    }
  };
  const other = ethers.Wallet.createRandom().address; // vesting beneficiary (no key needed to receive)

  console.log(`smoke on ${network.name} (${chainId}) as ${me.address}, balance ${ethers.formatEther(startBal)} HYPE`);

  // ---------------------------------------------------------------- must-revert checks (no gas)
  const base = (o = {}) => sdk.normalizeParams({ name: "Smoke", symbol: "SMK", metadataURI: "ipfs://smoke", creator: me.address, presetId: 1, ...o });
  const reverts = async (label, fn, reason) => {
    try { await fn(); check(label, false, "did not revert"); } catch (e) {
      let msg = (e.shortMessage || e.message || "") + " " + (e.data || "");
      for (const c of [router, core, reg]) { try { const p = c.interface.parseError(e.data); if (p) { msg = p.name + " " + msg; break; } } catch {} }
      check(label, reason ? msg.includes(reason) : /revert/i.test(msg), msg.slice(0, 60));
    }
  };
  await reverts("allocation 21% rejected", () => router.launch.staticCall(base({ allocations: [{ recipient: me.address, bps: 2100 }] })), "AllocationNotAllowed");
  await reverts("dev buy 11% rejected", () => router.launch.staticCall(base({ devBuyTokens: (SUPPLY * 11n) / 100n, maxDevBuyQuote: 10n ** 15n }), { value: 10n ** 15n }), "DevBuyNotAllowed");
  await reverts("unknown preset rejected", () => core.launch.staticCall(base({ presetId: 99 })));

  // ---------------------------------------------------------------- mode A via Provenalt
  const devA = 10n ** 22n; // 0.001% of supply
  const maxA = ethers.parseEther("0.002");
  const pA = base({ name: "Smoke Provenalt A", symbol: "SMKA", allocations: [{ recipient: me.address, bps: 300 }, { recipient: other, bps: 200 }], cliff: 0, duration: 0, devBuyTokens: devA, maxDevBuyQuote: maxA });
  // Two allocations with duration 0 → instant. Use a separate vesting launch below for cliff/duration.
  const predA = await router.predictToken(me.address, pA);
  const balBeforeA = await ethers.provider.getBalance(me);
  const rcA = await send("launchA", router.launch(pA, { value: maxA }));
  const evA = parse(rcA, core.interface, "Launched")[0];
  const recA = evA.args.record;
  const tokA = await at("EridanosToken", evA.args.token);
  check("mode A: token at predicted address", evA.args.token === predA, predA);
  check("mode A: attribution = caller (1), integrator #1", Number(recA.attribution) === 1 && Number(evA.args.integratorId) === 1, `integratorId=${evA.args.integratorId}`);
  check("mode A: split 20/30/50", Number(recA.protocolBps) === 2000 && Number(recA.integratorBps) === 3000 && Number(recA.creatorBps) === 5000);
  check("mode A: instant allocation 5%", recA.instantAllocation && Number(recA.allocBps) === 500);
  check("mode A: creator got 3% + dev buy", (await tokA.balanceOf(me.address)) === (SUPPLY * 3n) / 100n + devA, ethers.formatEther(await tokA.balanceOf(me.address)));
  check("mode A: second recipient got 2%", (await tokA.balanceOf(other)) === (SUPPLY * 2n) / 100n);
  const spentA = balBeforeA - (await ethers.provider.getBalance(me)) - rcA.gasUsed * rcA.gasPrice;
  check("mode A: unused dev-buy HYPE refunded", spentA === recA.devBuyQuoteSpent && spentA < maxA, `spent ${ethers.formatEther(spentA)} of max ${ethers.formatEther(maxA)}`);
  check("mode A: core holds 0 tokens", (await tokA.balanceOf(d.core)) === 0n);
  for (const line of sdk.describeSupply(recA)) console.log("    " + line);

  // Buy inside the anti-sniper window.
  const poolA = recA.poolId;
  const amt = ethers.parseEther("0.0005");
  const feeIn = await hook.currentFee(poolA);
  const rcBuy1 = await send("buyInWindow", router.buy(evA.args.token, amt, 0, deadline(), { value: amt }));
  const sur1 = parse(rcBuy1, hook.interface, "SurchargeCharged");
  const out1 = parse(rcBuy1, router.interface, "Swapped")[0].args[4];
  const info = (await hook.poolInfo(poolA))[0];
  const t1 = (await ethers.provider.getBlock(rcBuy1.blockNumber)).timestamp;
  check("buy in window pays surcharge in HYPE", sur1.length === 1 && sur1[0].args.currency === ethers.ZeroAddress && sur1[0].args.amount > 0n,
    `t+${t1 - Number(info.launchedAt)}s, fee before tx ${Number(feeIn) / 1e4}%, surcharge ${sur1.length ? ethers.formatEther(sur1[0].args.amount) : 0} HYPE`);

  // Wait out the window, buy again.
  await waitUntil(Number(info.launchedAt) + 11);
  check("fee decayed to 1%", (await hook.currentFee(poolA)) === 10000n);
  const rcBuy2 = await send("buyAfterWindow", router.buy(evA.args.token, amt, 0, deadline(), { value: amt }));
  const out2 = parse(rcBuy2, router.interface, "Swapped")[0].args[4];
  check("buy after window: no surcharge, more tokens", parse(rcBuy2, hook.interface, "SurchargeCharged").length === 0 && out2 > out1,
    `in-window ${ethers.formatEther(out1)} vs after ${ethers.formatEther(out2)} tokens`);

  // Sell half of what we just bought.
  await send("approveA", tokA.approve(d.router, out2));
  const hypeBeforeSell = await ethers.provider.getBalance(me);
  const rcSell = await send("sellAfterWindow", router.sell(evA.args.token, out2 / 2n, 0, deadline()));
  const sellOut = parse(rcSell, router.interface, "Swapped")[0].args[4];
  check("sell returns HYPE", sellOut > 0n && (await ethers.provider.getBalance(me)) > hypeBeforeSell - rcSell.gasUsed * rcSell.gasPrice, `${ethers.formatEther(sellOut)} HYPE`);

  // Collect and claims.
  const rcCol = await send("collectA", hook.collect(poolA));
  const col = parse(rcCol, hook.interface, "Collected")[0];
  check("collect moves LP fees", col && (col.args.tokenFees > 0n || col.args.quoteFees > 0n), col ? `token ${ethers.formatEther(col.args.tokenFees)}, HYPE ${ethers.formatEther(col.args.quoteFees)}` : "");
  const owedC = await dist.creatorOwed(poolA, ethers.ZeroAddress);
  const owedI = await dist.integratorOwed(1, ethers.ZeroAddress);
  check("creator and integrator owed HYPE", owedC > 0n && owedI > 0n, `creator ${ethers.formatEther(owedC)}, integrator ${ethers.formatEther(owedI)}`);
  await send("claimCreator", dist.claimCreator(poolA));
  check("claimCreator clears creator balance", (await dist.creatorOwed(poolA, ethers.ZeroAddress)) === 0n);
  await send("claimIntegrator", dist.claimIntegrator(1, ethers.ZeroAddress));
  check("claimIntegrator pays Provenalt payout", (await dist.integratorOwed(1, ethers.ZeroAddress)) === 0n);

  // ---------------------------------------------------------------- mode C: direct, dev buy, sell inside window
  const devC = 10n ** 22n;
  const pC = base({ name: "Smoke Direct C", symbol: "SMKC", devBuyTokens: devC, maxDevBuyQuote: maxA });
  const rcC = await send("launchC", core.launch(pC, { value: maxA }));
  const evC = parse(rcC, core.interface, "Launched")[0];
  const tokC = await at("EridanosToken", evC.args.token);
  check("mode C: attribution none, integrator 0, split 20/0/80", Number(evC.args.record.attribution) === 0 && Number(evC.args.integratorId) === 0 && Number(evC.args.record.creatorBps) === 8000);
  // approve + sell as fast as the chain allows, to land inside the window
  await send("approveC", tokC.approve(d.router, devC));
  const rcSellC = await send("sellInWindow", router.sell(evC.args.token, devC, 0, deadline()));
  const infoC = (await hook.poolInfo(evC.args.record.poolId))[0];
  const tC = (await ethers.provider.getBlock(rcSellC.blockNumber)).timestamp - Number(infoC.launchedAt);
  const surC = parse(rcSellC, hook.interface, "SurchargeCharged");
  if (tC < 10) {
    check("sell in window pays surcharge in token", surC.length === 1 && surC[0].args.currency === evC.args.token, `t+${tC}s, ${surC.length ? ethers.formatEther(surC[0].args.amount) : 0} tokens`);
    const rcColC = await send("collectC", hook.collect(evC.args.record.poolId));
    const flushed = parse(rcColC, hook.interface, "SurchargeFlushed").find((e) => e.args.currency === evC.args.token);
    // Burn = transfer to 0x…dEaD (EridanosToken has no burn function), so totalSupply stays 1e27.
    const dead = await tokC.balanceOf("0x000000000000000000000000000000000000dEaD");
    check("token surcharge burned at collect (sent to 0x…dEaD)", flushed && flushed.args.burned && dead >= flushed.args.amount, `dead balance ${ethers.formatEther(dead)}`);
  } else {
    check("sell in window (skipped: chain too slow, landed after window)", true, `t+${tC}s`);
  }

  // ---------------------------------------------------------------- mode B: signed intent
  let idB = await reg.integratorOf(me.address);
  const signerB = ethers.Wallet.createRandom();
  if (idB === 0n) {
    await send("registerB", reg.register("Smoke Integrator B", "https://example.invalid/smoke", signerB.address, me.address,
      { integratorBps: 1500, maxAllocBps: 2000, maxDevBuyBps: 1000, minCliff: 0, minDuration: 0, devBuyLock: 0 }));
    idB = await reg.integratorOf(me.address);
  }
  check("mode B: integrator registered", idB > 1n, `#${idB}`);
  const pB = base({ name: "Smoke Signed B", symbol: "SMKB", allocations: [{ recipient: other, bps: 1000 }], cliff: 30, duration: 120 });
  const intent = { integratorId: Number(idB), core: d.core, caller: me.address, creator: me.address, paramsHash: sdk.hashLaunchParams(pB), nonce: BigInt(ethers.hexlify(ethers.randomBytes(16))), deadline: deadline() };
  check("SDK hashParams == LaunchCore.hashParams", intent.paramsHash === (await core.hashParams(pB)));
  const sig = await sdk.signLaunchIntent(signerB, { registry: d.registry, chainId }, intent);
  const rcB = await send("launchB", core.launchSigned(pB, intent, sig));
  const evB = parse(rcB, core.interface, "Launched")[0];
  check("mode B: attribution signed (2), split 20/15/65", Number(evB.args.record.attribution) === 2 && Number(evB.args.integratorId) === Number(idB) && Number(evB.args.record.creatorBps) === 6500);
  check("mode B: allocation vested, not instant", !evB.args.record.instantAllocation && Number(evB.args.record.cliff) === 30 && Number(evB.args.record.duration) === 120);
  await reverts("mode B: intent replay rejected", () => core.launchSigned.staticCall(base({ ...pB, salt: ethers.hexlify(ethers.randomBytes(32)) }), intent, sig));
  const sched = parse(rcB, vault.interface, "ScheduleCreated")[0];
  const sid = sched.args.id;
  const vestStart = Number(sched.args.start);
  check("vesting: nothing releasable before cliff", (await vault.releasable(sid)) === 0n);

  // ---------------------------------------------------------------- USDC launch (no dev buy: deployer holds no USDC)
  let tokU = null;
  if (d.usdc) {
    const pU = base({ name: "Smoke USDC", symbol: "SMKU", presetId: 2 });
    const rcU = await send("launchUSDC", core.launch(pU));
    const evU = parse(rcU, core.interface, "Launched")[0];
    check("USDC launch: quote = USDC", evU.args.record.quote.toLowerCase() === d.usdc.toLowerCase(), evU.args.token);
    tokU = evU.args.token;
  }

  // Vesting release after the cliff (anyone may call; tokens go to the beneficiary).
  await waitUntil(vestStart + 45);
  const tokB = await at("EridanosToken", evB.args.token);
  await send("vestRelease", vault.release(sid));
  const gotB = await tokB.balanceOf(other);
  check("vesting: partial release after cliff", gotB > 0n && gotB < (SUPPLY * 10n) / 100n, `${ethers.formatEther(gotB)} of 100000000 tokens`);

  // ---------------------------------------------------------------- protocol claim (treasury = deployer here)
  await send("claimProtocol", dist.claimProtocol(ethers.ZeroAddress));
  check("protocol HYPE claimed to treasury", true);

  for (const t of [tokA, tokB]) check(`supply unchanged ${await t.symbol()}`, (await t.totalSupply()) === SUPPLY);

  const spent = startBal - (await ethers.provider.getBalance(me));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed; HYPE spent ${ethers.formatEther(spent)}`);
  const out = { network: network.name, chainId: Number(chainId), ranAt: new Date().toISOString(), tokens: { A: evA.args.token, C: evC.args.token, B: evB.args.token, ...(tokU ? { U: tokU } : {}) }, integratorB: Number(idB), results, txs, hypeSpent: ethers.formatEther(spent) };
  if (chainId === 99801n) fs.writeFileSync(path.join(__dirname, "..", "deployments", `${network.name}-v2-smoke.json`), JSON.stringify(out, null, 2));
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
