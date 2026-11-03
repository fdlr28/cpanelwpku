// Edit after deploying (values printed by scripts/deploy.js / deployments/<network>.json).
// Network values from https://elysium.kinetiq.xyz/docs/connecting-to-elysium
window.LAUNCHPAD_CONFIG = window.LAUNCHPAD_CONFIG || {
  chainId: 99801,
  chainName: "Elysium Testnet",
  // Public RPC is shared by everyone; for production use an Alchemy endpoint:
  // https://elysium-testnet.g.alchemy.com/v2/{API_KEY}
  rpcUrl: "https://testnet-rpc.elysium.kinetiq.xyz",
  explorer: "https://elysium.kinetiq.xyz/testnet-explorer",
  launchpad: "0x0000000000000000000000000000000000000000",
  router: "", // Uniswap V2 Router02 used for trading after graduation
  wrappedNative: "0xCD57F65c2B0e5881CFC2E609F7CD53b746E1F234", // WHYPE (testnet)
  deployBlock: 0,
};
