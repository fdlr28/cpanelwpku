// Copies the addresses the indexer needs from ../deployments/<network>-v2.json into indexer/deployment.json.
//   node indexer/scripts/copy-deployment.js [elysiumTestnet]
// Railway builds only the indexer/ folder, so the indexer carries its own copy.
const fs = require("fs");
const path = require("path");

const network = process.argv[2] || "elysiumTestnet";
const src = path.join(__dirname, "..", "..", "deployments", `${network}-v2.json`);
const d = JSON.parse(fs.readFileSync(src, "utf8"));
const keys = ["network", "chainId", "poolManager", "core", "hook", "router", "registry", "distributor", "vault", "config", "usdc", "deployBlock"];
const out = Object.fromEntries(keys.map((k) => [k, d[k]]));
out.rpcUrl = d.chainId === 99801 ? "https://testnet-rpc.elysium.kinetiq.xyz" : "";
out._source = `Copied from deployments/${network}-v2.json (regenerate: node indexer/scripts/copy-deployment.js)`;
const dst = path.join(__dirname, "..", "deployment.json");
// Keep the hidden-token list (not part of the contract deployment record) when re-copying the same network.
try {
  const prev = JSON.parse(fs.readFileSync(dst, "utf8"));
  if (prev.chainId === out.chainId && Array.isArray(prev.hiddenTokens)) {
    out.hiddenTokens = prev.hiddenTokens;
    out._hiddenTokens = prev._hiddenTokens;
  }
} catch {}
fs.writeFileSync(dst, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${path.relative(process.cwd(), dst)} from ${path.relative(process.cwd(), src)}`);
