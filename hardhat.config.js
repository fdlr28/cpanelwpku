require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

const SOLC_VERSION = "0.8.28";

// Use the solcjs (wasm) build bundled in node_modules/solc instead of downloading
// a compiler from binaries.soliditylang.org. Handy for offline / restricted CI.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (args.solcVersion === SOLC_VERSION && process.env.USE_NATIVE_SOLC !== "1") {
    const solcPkg = require("solc/package.json");
    return {
      compilerPath: require.resolve("solc/soljson.js"),
      isSolcJs: true,
      version: args.solcVersion,
      longVersion: solcPkg.version,
    };
  }
  return runSuper();
});

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const accounts = PRIVATE_KEY ? [PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: SOLC_VERSION,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Elysium is an Arbitrum Orbit (Nitro) chain; recent ArbOS supports Cancun opcodes
      // (except blobs). Switch to "paris" if your target chain rejects PUSH0/MCOPY.
      evmVersion: process.env.EVM_VERSION || "cancun",
    },
  },
  networks: {
    hardhat: {},
    localhost: { url: "http://127.0.0.1:8545" },
    elysiumTestnet: {
      url: process.env.ELYSIUM_TESTNET_RPC || "https://testnet-rpc.elysium.kinetiq.xyz",
      chainId: 99801,
      accounts,
    },
    elysium: {
      // Mainnet chain ID / RPC were not published at the time of writing. Fill them in
      // from https://elysium.kinetiq.xyz/docs before deploying.
      url: process.env.ELYSIUM_RPC || "",
      chainId: process.env.ELYSIUM_CHAIN_ID ? Number(process.env.ELYSIUM_CHAIN_ID) : undefined,
      accounts,
    },
  },
};
