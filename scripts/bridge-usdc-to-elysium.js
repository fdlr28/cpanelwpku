// Bridges testnet USDC from HyperEVM (998) to Elysium testnet (99801) through Elysium's canonical token bridge
// (the stock Arbitrum Nitro gateway; docs: elysium.kinetiq.xyz/docs/bridging-hyperevm-tokens-to-elysium).
// Run by the wallet holding USDC on HyperEVM (PRIVATE_KEY in .env):
//   CONFIRM=yes npx hardhat run scripts/bridge-usdc-to-elysium.js --network hyperevmTestnet
// Optional: AMOUNT (USDC, default 5), RECIPIENT (Elysium address, default the same wallet).
// Two transactions on HyperEVM (approve the gateway, deposit through the router) plus ~0.0005 HYPE delivery fee;
// unused delivery fee is refunded to the recipient on Elysium. USDC arrives on Elysium in about a minute.
const hre = require("hardhat");
const { ethers } = hre;

// Testnet addresses from the Elysium docs (Contract addresses / Bridging HyperEVM tokens to Elysium).
const HYPEREVM_USDC = "0x2B3370eE501B4a559b57D449569354196457D8Ab";
const ELYSIUM_USDC = "0x7D29d8047B905000459c0E80c34a26CeedcB47b2";
const ROUTER = "0x1aAE2caD8B0249905492087EF230FcCEa3707C45";
const ELYSIUM_RPC = process.env.ELYSIUM_TESTNET_RPC || "https://testnet-rpc.elysium.kinetiq.xyz";

const ROUTER_ABI = [
  "function outboundTransfer(address token, address to, uint256 amount, uint256 maxGas, uint256 gasPriceBid, bytes data) payable returns (bytes)",
  "function getGateway(address token) view returns (address)",
  "function calculateL2TokenAddress(address token) view returns (address)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)", "function decimals() view returns (uint8)",
];

// Delivery parameters, as in the docs sample, with headroom; any excess is refunded on Elysium.
const MAX_GAS = 300_000n;
const MAX_SUBMISSION_COST = 400_000_000_000_000n; // 0.0004 HYPE

/** Builds the outboundTransfer arguments and the HYPE value that funds delivery on Elysium. */
async function depositArgs(elysium, recipient, amount) {
  const live = (await elysium.getFeeData()).gasPrice ?? 100_000_000n;
  const minBid = 100_000_000n; // 0.1 gwei
  const gasPriceBid = live * 2n > minBid ? live * 2n : minBid; // 2x the live Elysium price
  const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "bytes"], [MAX_SUBMISSION_COST, "0x"]);
  const value = MAX_SUBMISSION_COST + MAX_GAS * gasPriceBid;
  return { args: [HYPEREVM_USDC, recipient, amount, MAX_GAS, gasPriceBid, data], value, gasPriceBid };
}

async function main() {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (chainId !== 998n) throw new Error(`Run with --network hyperevmTestnet (got chain ${chainId})`);
  if (process.env.CONFIRM !== "yes") throw new Error("Re-run with CONFIRM=yes");
  const [me] = await ethers.getSigners();
  if (!me) throw new Error("No signer: set PRIVATE_KEY in .env");
  const recipient = ethers.getAddress(process.env.RECIPIENT || me.address);
  const elysium = new ethers.JsonRpcProvider(ELYSIUM_RPC, 99801, { staticNetwork: true });

  const router = new ethers.Contract(ROUTER, ROUTER_ABI, me);
  const usdc = new ethers.Contract(HYPEREVM_USDC, ERC20_ABI, me);
  const usdcL2 = new ethers.Contract(ELYSIUM_USDC, ERC20_ABI, elysium);
  const dec = Number(await usdc.decimals());
  const amount = ethers.parseUnits(process.env.AMOUNT || "5", dec);

  // Safety: this token must map to the USDC the protocol whitelists on Elysium.
  const l2 = await router.calculateL2TokenAddress(HYPEREVM_USDC);
  if (l2.toLowerCase() !== ELYSIUM_USDC.toLowerCase()) throw new Error(`unexpected Elysium token ${l2}`);
  const gateway = await router.getGateway(HYPEREVM_USDC);

  const bal = await usdc.balanceOf(me.address);
  const hype = await ethers.provider.getBalance(me.address);
  console.log(`HyperEVM ${me.address}: ${ethers.formatUnits(bal, dec)} USDC, ${ethers.formatEther(hype)} HYPE`);
  console.log(`bridging ${ethers.formatUnits(amount, dec)} USDC → Elysium ${recipient} (gateway ${gateway})`);
  if (bal < amount) throw new Error("not enough USDC on HyperEVM");

  if ((await usdc.allowance(me.address, gateway)) < amount) {
    const rc = await (await usdc.approve(gateway, amount)).wait();
    console.log(`approve tx ${rc.hash}`);
  }

  const before = await usdcL2.balanceOf(recipient);
  const { args, value, gasPriceBid } = await depositArgs(elysium, recipient, amount);
  console.log(`delivery fee ${ethers.formatEther(value)} HYPE (gas bid ${ethers.formatUnits(gasPriceBid, "gwei")} gwei; excess refunded on Elysium)`);
  const rc = await (await router.outboundTransfer(...args, { value })).wait();
  console.log(`deposit tx ${rc.hash} (HyperEVM block ${rc.blockNumber})`);

  process.stdout.write("waiting for USDC on Elysium");
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const now = await usdcL2.balanceOf(recipient);
    if (now > before) {
      console.log(`\n✓ Elysium ${recipient}: ${ethers.formatUnits(now, dec)} USDC (+${ethers.formatUnits(now - before, dec)})`);
      return;
    }
    process.stdout.write(".");
  }
  console.log("\nNot arrived after 5 minutes. The deposit is not lost: check https://testnet.elysium.kinetiq.xyz/bridge-transfers"
    + " (a stuck delivery can be re-executed there).");
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exitCode = 1; });
