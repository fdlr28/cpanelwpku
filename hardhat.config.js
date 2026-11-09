require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

// Compilers come from npm (solcjs/wasm) instead of binaries.soliditylang.org, which is
// unreachable from restricted CI. 0.8.28 builds the legacy MVP; 0.8.26 builds the v2
// protocol (same compiler as Uniswap v4-core, which v2 imports).
const SOLCJS = {
  "0.8.28": "solc",
  "0.8.26": "solc0826",
};

subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  const pkg = SOLCJS[args.solcVersion];
  if (pkg && process.env.USE_NATIVE_SOLC !== "1") {
    return {
      compilerPath: require.resolve(`${pkg}/soljson.js`),
      isSolcJs: true,
      version: args.solcVersion,
      longVersion: require(`${pkg}/package.json`).version,
    };
  }
  return runSuper();
});

// Elysium is an Arbitrum Orbit (Nitro) chain; its ArbOS supports Cancun opcodes
// (PUSH0, MCOPY, TSTORE) except blobs. Uniswap v4 requires Cancun (transient storage).
const EVM_VERSION = process.env.EVM_VERSION || "cancun";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const accounts = PRIVATE_KEY ? [PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [
      { version: "0.8.28", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: EVM_VERSION } },
      // viaIR like Uniswap v4-core itself; needed for the v4 hook/launch code paths.
      { version: "0.8.26", settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: EVM_VERSION } },
    ],
  },
  networks: {
    hardhat: { hardfork: "cancun" },
    localhost: { url: "http://127.0.0.1:8545" },
    elysiumTestnet: {
      // Public RPC from the docs; Alchemy (https://elysium-testnet.g.alchemy.com/v2/KEY) is recommended.
      url: process.env.ELYSIUM_TESTNET_RPC || "https://testnet-rpc.elysium.kinetiq.xyz",
      chainId: 99801,
      accounts,
    },
    hyperevmTestnet: {
      // Elysium's parent chain: token deposits to Elysium start here (scripts/bridge-usdc-to-elysium.js).
      url: process.env.HYPEREVM_TESTNET_RPC || "https://rpc.hyperliquid-testnet.xyz/evm",
      chainId: 998,
      accounts,
    },
    elysium: {
      // Mainnet chain ID is published at launch (https://elysium.kinetiq.xyz/docs/connecting-to-elysium).
      url: process.env.ELYSIUM_RPC || "",
      chainId: process.env.ELYSIUM_CHAIN_ID ? Number(process.env.ELYSIUM_CHAIN_ID) : undefined,
      accounts,
    },
  },
};
