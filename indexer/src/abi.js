// Event and view fragments the indexer reads. Kept here (not imported from ../sdk) because Railway builds
// only the indexer/ folder.
const { Interface } = require("ethers");

const LAUNCH_RECORD =
  "tuple(bytes32 poolId,address creator,address caller,uint8 attribution,address quote,uint16 presetId," +
  "uint16 protocolBps,uint16 integratorBps,uint16 creatorBps,uint16 allocBps,uint32 cliff,uint32 duration," +
  "bool instantAllocation,uint256 devBuyTokens,uint256 devBuyQuoteSpent,uint32 devBuyLock,uint256 poolTokens)";

const core = new Interface([
  `event Launched(uint256 indexed launchId, address indexed token, uint32 indexed integratorId, ${LAUNCH_RECORD} record, uint16 coreVersion)`,
]);

const poolManager = new Interface([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);

const router = new Interface([
  "event Swapped(address indexed token, address indexed trader, bool buy, uint256 amountIn, uint256 amountOut)",
]);

const distributor = new Interface([
  "event FeesSplit(bytes32 indexed poolId, address indexed currency, uint256 amount, uint256 toProtocol, uint256 toIntegrator, uint256 toCreator)",
]);

const POLICY = "tuple(uint16 integratorBps,uint16 maxAllocBps,uint16 maxDevBuyBps,uint32 minCliff,uint32 minDuration,uint32 devBuyLock)";
const registry = new Interface([
  "event IntegratorRegistered(uint32 indexed id, address indexed account, address signer, address payout, bool approved)",
  "event ProfileUpdated(uint32 indexed id, string name, string uri)",
  "event PayoutUpdated(uint32 indexed id, address payout)",
  "event AccountTransferred(uint32 indexed id, address indexed oldAccount, address indexed newAccount)",
  "event VerifiedSet(uint32 indexed id, bool verified)",
  "event SuspendedSet(uint32 indexed id, bool suspended)",
  `function getIntegrator(uint32 id) view returns (tuple(address account,address pendingAccount,address signer,address payout,bool selfActive,bool suspended,bool approved,bool verified,uint64 pendingPolicyAt,${POLICY} policy,${POLICY} pendingPolicy,string name,string uri))`,
]);

const erc20 = new Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function metadataURI() view returns (string)",
]);

module.exports = { core, poolManager, router, distributor, registry, erc20, TRANSFER_TOPIC: erc20.getEvent("Transfer").topicHash };
