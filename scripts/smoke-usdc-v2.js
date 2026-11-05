// Smoke test for the USDC quote: launch with a dev buy, buy inside/after the anti-sniper window, sell,
// collect, and claim (creator, integrator, protocol). Run by a wallet that holds a few testnet USDC:
//   CONFIRM=yes npx hardhat run scripts/smoke-usdc-v2.js --network elysiumTestnet
// Spends at most ~2.1 USDC (most of it comes back from the sell and the claims) and a little HYPE for gas.
// Only 99801 (testnet) and 31337 (local) are accepted.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const sdk = require("../sdk/eridanos-sdk.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)",
  "function symbol() view returns (string)", "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
];

async function main() {
  const { ethers, network } = hre;
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (![99801n, 31337n].includes(chainId)) throw new Error(`Refusing chain ${chainId}`);
  if (chainId === 99801n && process.env.CONFIRM !== "yes") throw new Error("Re-run with CONFIRM=yes");
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}-v2.json`), "utf8"));
  const [me] = await ethers.getSigners();
  if (!me) throw new Error("No signer: set PRIVATE_KEY in .env");
  const at = (name, a) => ethers.getContractAt(name, a, me);
  const core = await at("LaunchCore", d.core);
  const hook = await at("CurveHook", d.hook);
  const dist = await at("FeeDistributor", d.distributor);
  const config = await at("ProtocolConfig", d.config);
  const router = await at("HypelysRouter", d.router);
  const usdc = new ethers.Contract(d.usdc, ERC20_ABI, me);
  const dec = Number(await usdc.decimals());
  const U = (x) => ethers.parseUnits(x, dec);
  const fmt = (x) => ethers.formatUnits(x, dec);

  const results = [];
  const txs = {};
  const check = (name, ok, info = "") => { results.push({ name, ok: !!ok, info: String(info) }); console.log(`${ok ? "✓" : "✗"} ${name}${info !== "" ? " — " + info : ""}`); };
  const send = async (label, p) => { const rc = await (await p).wait(); txs[label] = rc.hash; return rc; };
  const parse = (rc, iface, name) => rc.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).filter((e) => e && e.name === name);
  const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);
  const waitUntil = async (ts) => {
    while ((await ethers.provider.getBlock("latest")).timestamp < ts) {
      if (chainId === 31337n) await ethers.provider.send("evm_mine", []);
      await sleep(1000);
    }
  };

  // USDC preset: the first usable preset whose quote is d.usdc.
  let presetId = 0;
  for (let i = 1; i <= Number(await config.presetCount()); i++) {
    const [info] = await config.preset(i);
    if (info.quote.toLowerCase() === d.usdc.toLowerCase() && (await config.isPresetUsable(i))) { presetId = i; break; }
  }
  if (!presetId) throw new Error("no usable USDC preset");

  const devMax = U("1"); // dev buy budget; 0.01% of supply costs ≈ 0.79 USDC at the start price
  const buyAmt = U("0.5");
  const need = devMax + 2n * buyAmt;
  const usdcStart = await usdc.balanceOf(me.address);
  const hypeStart = await ethers.provider.getBalance(me.address);
  console.log(`wallet ${me.address}: ${fmt(usdcStart)} USDC, ${ethers.formatEther(hypeStart)} HYPE; preset ${presetId}`);
  if (usdcStart < need) throw new Error(`need at least ${fmt(need)} USDC`);

  // One exact approval up front, so the in-window buy right after the launch needs no extra transaction.
  await send("approveUSDC", usdc.approve(d.router, need));

  // ---------------------------------------------------------------- launch with dev buy
  const devTokens = 10n ** 23n; // 0.01% of supply
  const p = sdk.normalizeParams({
    name: "Smoke USDC Dev", symbol: "SMKUD", metadataURI: "ipfs://smoke-usdc", creator: me.address, presetId,
    allocations: [{ recipient: me.address, bps: 200 }], devBuyTokens: devTokens, maxDevBuyQuote: devMax,
  });
  const usdcBeforeLaunch = await usdc.balanceOf(me.address);
  const rcL = await send("launch", router.launch(p));
  const ev = parse(rcL, core.interface, "Launched")[0];
  const rec = ev.args.record;
  const token = await at("EridanosToken", ev.args.token);
  const poolId = rec.poolId;
  check("launch: quote = USDC, integrator #1, split 20/30/50",
    rec.quote.toLowerCase() === d.usdc.toLowerCase() && Number(ev.args.integratorId) === 1 && Number(rec.creatorBps) === 5000, ev.args.token);
  check("launch: dev buy filled exactly", rec.devBuyTokens === devTokens, `${ethers.formatEther(rec.devBuyTokens)} tokens for ${fmt(rec.devBuyQuoteSpent)} USDC`);
  const spentL = usdcBeforeLaunch - (await usdc.balanceOf(me.address));
  check("launch: only the spent USDC left the wallet (rest refunded)", spentL === rec.devBuyQuoteSpent && spentL < devMax, `spent ${fmt(spentL)} of max ${fmt(devMax)}`);
  check("launch: router and core keep no USDC", (await usdc.balanceOf(d.router)) === 0n && (await usdc.balanceOf(d.core)) === 0n);
  check("launch: wallet got 2% allocation + dev buy", (await token.balanceOf(me.address)) === (10n ** 27n * 2n) / 100n + devTokens);

  // ---------------------------------------------------------------- buy inside the window
  const rcB1 = await send("buyInWindow", router.buy(ev.args.token, buyAmt, 0, deadline()));
  const [info] = await hook.poolInfo(poolId);
  const t1 = (await ethers.provider.getBlock(rcB1.blockNumber)).timestamp - Number(info.launchedAt);
  const sur = parse(rcB1, hook.interface, "SurchargeCharged");
  const out1 = parse(rcB1, router.interface, "Swapped")[0].args[4];
  if (t1 < 10) {
    const expected = sdk.surchargeExactIn(buyAmt, t1);
    check("buy in window pays surcharge in USDC (matches SDK formula)",
      sur.length === 1 && sur[0].args.currency.toLowerCase() === d.usdc.toLowerCase() && sur[0].args.amount === expected,
      `t+${t1}s, surcharge ${sur.length ? fmt(sur[0].args.amount) : 0} USDC`);
  } else {
    check("buy in window (skipped: landed after the window)", true, `t+${t1}s`);
  }

  // ---------------------------------------------------------------- buy after the window
  await waitUntil(Number(info.launchedAt) + 11);
  const rcB2 = await send("buyAfterWindow", router.buy(ev.args.token, buyAmt, 0, deadline()));
  const out2 = parse(rcB2, router.interface, "Swapped")[0].args[4];
  check("buy after window: no surcharge, more tokens", parse(rcB2, hook.interface, "SurchargeCharged").length === 0 && out2 > out1,
    `${ethers.formatEther(out1)} vs ${ethers.formatEther(out2)} tokens`);

  // ---------------------------------------------------------------- sell
  const sellAmt = out2 / 2n;
  await send("approveToken", token.approve(d.router, sellAmt));
  const usdcBeforeSell = await usdc.balanceOf(me.address);
  const rcS = await send("sell", router.sell(ev.args.token, sellAmt, 0, deadline()));
  const sellOut = parse(rcS, router.interface, "Swapped")[0].args[4];
  check("sell returns USDC", sellOut > 0n && (await usdc.balanceOf(me.address)) - usdcBeforeSell === sellOut, `${fmt(sellOut)} USDC`);

  // ---------------------------------------------------------------- collect + claims
  const rcC = await send("collect", hook.collect(poolId));
  const col = parse(rcC, hook.interface, "Collected")[0];
  check("collect: USDC LP fees", col && col.args.quoteFees > 0n, col ? `${fmt(col.args.quoteFees)} USDC, ${ethers.formatEther(col.args.tokenFees)} tokens` : "");
  const flushed = parse(rcC, hook.interface, "SurchargeFlushed").find((e) => e.args.currency.toLowerCase() === d.usdc.toLowerCase());
  if (sur.length) check("collect: USDC surcharge sent to the protocol (not burned)", flushed && !flushed.args.burned && flushed.args.amount >= sur[0].args.amount, flushed ? fmt(flushed.args.amount) : "");

  const owedC = await dist.creatorOwed(poolId, d.usdc);
  const owedI = await dist.integratorOwed(1, d.usdc);
  const owedP = await dist.protocolOwed(d.usdc);
  check("fees owed in USDC to creator / integrator / protocol", owedC > 0n && owedI > 0n && owedP > 0n, `${fmt(owedC)} / ${fmt(owedI)} / ${fmt(owedP)}`);
  const claim = async (label, call, owed, to) => {
    const before = await usdc.balanceOf(to);
    await send(label, call);
    check(`${label} pays ${fmt(owed)} USDC to ${to.slice(0, 8)}…`, (await usdc.balanceOf(to)) - before === owed);
  };
  await claim("claimCreator", dist.claimCreator(poolId), owedC, me.address);
  const reg = await at("IntegratorRegistry", d.registry);
  await claim("claimIntegrator", dist.claimIntegrator(1, d.usdc), owedI, (await reg.getIntegrator(1)).payout);
  await claim("claimProtocol", dist.claimProtocol(d.usdc), owedP, await config.treasury());

  check("token supply unchanged", (await token.totalSupply()) === 10n ** 27n);

  const usdcEnd = await usdc.balanceOf(me.address);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed; net USDC ${usdcEnd >= usdcStart ? "+" : "-"}${fmt(usdcEnd >= usdcStart ? usdcEnd - usdcStart : usdcStart - usdcEnd)}, HYPE for gas ${ethers.formatEther(hypeStart - (await ethers.provider.getBalance(me.address)))}`);
  const out = { network: network.name, chainId: Number(chainId), ranAt: new Date().toISOString(), wallet: me.address, token: ev.args.token, poolId, results, txs };
  fs.writeFileSync(path.join(__dirname, "..", "deployments", `${network.name}-v2-smoke-usdc.json`), JSON.stringify(out, null, 2));
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exitCode = 1; });
