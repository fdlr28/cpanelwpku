// Canonical Elysium contracts, from https://elysium.kinetiq.xyz/docs/contract-addresses
// (testnet, last updated 2026-10-20). Mainnet addresses are published at launch.
module.exports = {
  elysiumTestnet: {
    chainId: 99801,
    WHYPE: "0xCD57F65c2B0e5881CFC2E609F7CD53b746E1F234",
    USDC: "0x7D29d8047B905000459c0E80c34a26CeedcB47b2",
    multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
    gatewayRouter: "0x89659883a9d980925733B0A698F117AAb65ac718",
    bridgeFactory: "0xb94A38a4aC46970559E89E566f2486a3Fc56BE5a", // mirror bridge to HyperEVM
    explorer: "https://elysium.kinetiq.xyz/testnet-explorer",
    publicRpc: "https://testnet-rpc.elysium.kinetiq.xyz",
  },
  elysium: {
    // Fill in at mainnet launch.
  },
};
