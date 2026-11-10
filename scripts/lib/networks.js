// Elysium network metadata shared by the deploy, verify, indexer-copy and frontend-config scripts.
// Source: elysium.kinetiq.xyz/docs ("Connecting to Elysium" and "Contract addresses", updated 9 Nov 2026).
// Mainnet USDC checked on chain 10 Nov 2026: symbol USDC, 6 decimals, l1Address() = Circle USDC on HyperEVM
// (0xb88339CB7199b77E23DB6E890353E22632Ba630f).
const NETWORKS = {
  99801: {
    key: "elysiumTestnet",
    name: "Elysium Testnet",
    rpcEnv: "ELYSIUM_TESTNET_RPC",
    publicRpc: "https://testnet-rpc.elysium.kinetiq.xyz",
    explorer: "https://explorer-elysium-testnet.t.conduit.xyz",
    usdc: "0x7D29d8047B905000459c0E80c34a26CeedcB47b2",
    whype: "0xCD57F65c2B0e5881CFC2E609F7CD53b746E1F234",
  },
  99901: {
    key: "elysiumMainnet",
    name: "Elysium",
    rpcEnv: "ELYSIUM_MAINNET_RPC",
    publicRpc: "https://rpc.elysium.kinetiq.xyz",
    explorer: "https://elysium.kinetiq.xyz", // links: <explorer>/address/0x…, /tx/0x… (as in the docs)
    usdc: "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65",
    usdcL1: "0xb88339CB7199b77E23DB6E890353E22632Ba630f",
    whype: "0xbA876237B0F021A6c6D852d6c26E107997cC5E81",
  },
};

/** Network metadata for a chain ID, or null. */
function networkOf(chainId) {
  return NETWORKS[Number(chainId)] || null;
}

/** RPC URL for a chain: its env override (e.g. an Alchemy URL) or the public endpoint. */
function rpcOf(chainId) {
  const n = networkOf(chainId);
  if (!n) return "";
  return process.env[n.rpcEnv] || n.publicRpc;
}

module.exports = { NETWORKS, networkOf, rpcOf };
