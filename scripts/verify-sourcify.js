// Verifies the Eridanos v2 deployment on Conduit's Sourcify server (what the Elysium testnet explorer reads;
// the server also covers mainnet 99901).
//   node scripts/verify-sourcify.js [deployments/elysiumTestnet-v2.json | deployments/elysiumMainnet-v2.json]
// Behind an HTTP proxy: NODE_USE_ENV_PROXY=1. Needs `npx hardhat compile` artifacts matching the deployment.
// Also verifies every EridanosToken launched through the deployment's LaunchCore.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const sdk = require("../sdk/eridanos-sdk.js");
const { rpcOf } = require("./lib/networks");

const API = process.env.SOURCIFY_URL || "https://contracts.conduit.xyz";
const ROOT = path.join(__dirname, "..");
const file = process.argv[2] || path.join(ROOT, "deployments", "elysiumTestnet-v2.json");
const d = JSON.parse(fs.readFileSync(file, "utf8"));
const RPC = rpcOf(d.chainId); // ELYSIUM_TESTNET_RPC / ELYSIUM_MAINNET_RPC override the public endpoints
if (!RPC) throw new Error(`no RPC known for chain ${d.chainId}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hardhatJob(source, name) {
  const dbg = path.join(ROOT, "artifacts", source, `${name}.dbg.json`);
  const bi = JSON.parse(fs.readFileSync(path.join(path.dirname(dbg), JSON.parse(fs.readFileSync(dbg, "utf8")).buildInfo), "utf8"));
  const longVersion = bi.solcLongVersion.includes("+commit") ? bi.solcLongVersion : require(bi.solcVersion === "0.8.26" ? "solc0826" : "solc").version();
  return { stdJsonInput: bi.input, compilerVersion: longVersion.replace(/\.Emscripten.*$/, ""), contractIdentifier: `${source}:${name}` };
}

async function api(method, url, body) {
  const r = await fetch(API + url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 300) }; }
  return { status: r.status, j };
}

async function status(chainId, address) {
  const { j } = await api("GET", `/v2/contract/${chainId}/${address}`);
  return j.match || null;
}

async function verify(chainId, label, address, job) {
  const already = await status(chainId, address);
  if (already) { console.log(`= ${label} ${address}: already ${already}`); return already; }
  const url = `/v2/verify/${chainId}/${address}`;
  const body = job;
  const res = await api("POST", url, body);
  if (res.status >= 300 || !res.j.verificationId) { console.log(`✗ ${label} ${address}: HTTP ${res.status} ${JSON.stringify(res.j).slice(0, 300)}`); return null; }
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const { j } = await api("GET", `/v2/verify/${res.j.verificationId}`);
    if (j.isJobCompleted) {
      const m = j.contract && j.contract.match;
      console.log(`${m ? "✓" : "✗"} ${label} ${address}: ${m || JSON.stringify(j.error || j).slice(0, 300)}`);
      return m || null;
    }
  }
  console.log(`? ${label} ${address}: timed out`);
  return null;
}

async function main() {
  const chainId = d.chainId;
  const jobs = [
    ["Infinity Vault", d.infinityVault, hardhatJob("contracts/vendor/infinity/src/Vault.sol", "Vault")],
    ["Infinity CLPoolManager", d.poolManager, hardhatJob("contracts/vendor/infinity/src/pool-cl/CLPoolManager.sol", "CLPoolManager")],
    ["EridanosTimelock", d.timelock, hardhatJob("contracts/v2/governance/EridanosTimelock.sol", "EridanosTimelock")],
    ["ProtocolConfig", d.config, hardhatJob("contracts/v2/ProtocolConfig.sol", "ProtocolConfig")],
    ["IntegratorRegistry", d.registry, hardhatJob("contracts/v2/IntegratorRegistry.sol", "IntegratorRegistry")],
    ["VestingVault", d.vault, hardhatJob("contracts/v2/VestingVault.sol", "VestingVault")],
    ["CurveHook", d.hook, hardhatJob("contracts/v2/CurveHook.sol", "CurveHook")],
    ["FeeDistributor", d.distributor, hardhatJob("contracts/v2/FeeDistributor.sol", "FeeDistributor")],
    ["LaunchCore", d.core, hardhatJob("contracts/v2/LaunchCore.sol", "LaunchCore")],
    ["ProvenaltRouter", d.router, hardhatJob("contracts/v2/app/ProvenaltRouter.sol", "ProvenaltRouter")],
  ];
  const provider = new ethers.JsonRpcProvider(RPC, chainId, { staticNetwork: true });
  const launches = await sdk.listLaunches(provider, d.core, { fromBlock: d.deployBlock || 0 });
  const tokenJob = hardhatJob("contracts/v2/EridanosToken.sol", "EridanosToken");
  for (const l of launches) jobs.push([`EridanosToken #${l.launchId}`, l.token, tokenJob]);

  const out = {};
  for (const [label, address, job] of jobs) out[address] = { label, match: await verify(chainId, label, address, job) };
  const ok = Object.values(out).filter((v) => v.match).length;
  console.log(`\n${ok}/${jobs.length} verified on ${API} (chain ${chainId})`);
  d.verification = { server: API, checkedAt: new Date().toISOString(), contracts: out };
  fs.writeFileSync(file, JSON.stringify(d, null, 2));
  if (ok !== jobs.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
