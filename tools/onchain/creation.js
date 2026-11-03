const { ethers } = require("ethers");
const p = new ethers.JsonRpcProvider("https://rpc-live.elyspump.com", 99901, { staticNetwork: true, batchMaxCount: 1 });
const T = ethers.id("Transfer(address,address,uint256)");
const fs = require("fs");
(async () => {
  const head = await p.getBlockNumber();
  const out = {};
  for (const t of process.argv.slice(2)) {
    let found = null;
    for (let to = head; to > 0 && !found; to -= 10000) {
      const from = Math.max(0, to - 9999);
      const logs = await p.getLogs({ address: t, topics: [T, ethers.zeroPadValue("0x", 32)], fromBlock: from, toBlock: to });
      if (logs.length) found = logs[0];
    }
    if (!found) { console.log(t, "no mint found"); continue; }
    const tx = await p.getTransaction(found.transactionHash);
    const rc = await p.getTransactionReceipt(found.transactionHash);
    console.log(`\n== ${t} block ${found.blockNumber} tx ${tx.hash}`);
    console.log(`  from ${tx.from} -> to ${tx.to} value ${ethers.formatEther(tx.value)} HYPE selector ${tx.data.slice(0, 10)} datalen ${(tx.data.length - 2) / 2}`);
    const emitters = {};
    for (const l of rc.logs) { const k = l.address; emitters[k] = emitters[k] || []; emitters[k].push(l.topics[0]); }
    for (const [a, ts] of Object.entries(emitters)) console.log(`  logs from ${a}: ${ts.map(x => x.slice(0, 10)).join(",")}`);
    out[t] = { block: found.blockNumber, tx: tx.hash, from: tx.from, to: tx.to, value: tx.value.toString(), data: tx.data, logs: rc.logs.map(l => ({ address: l.address, topics: l.topics, data: l.data })) };
  }
  fs.writeFileSync((process.env.OUT || __dirname) + "/creation.json", JSON.stringify(out, null, 1));
})().catch(e => { console.error("ERR", e.shortMessage || e.message); process.exit(1); });
