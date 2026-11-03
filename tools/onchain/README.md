# Analisis on-chain launchpad Elysium

Skrip yang dipakai untuk `docs/riset-launchpad-elysium.md`. Default RPC: `rpc-live.elyspump.com` (mainnet 99901).
Di balik proxy HTTP, jalankan dengan `NODE_USE_ENV_PROXY=1`.

```bash
node tools/onchain/inspect.js <token...>     # metadata ERC-20, ukuran bytecode
node tools/onchain/creation.js <token...>    # cari tx pembuatan → creation.json
node tools/onchain/decode.js                 # decode event V4 PoolManager dari creation.json
node tools/onchain/words.js 0x274c55b0,...   # dump word mentah event kustom
node tools/onchain/scan.js                   # histogram event per kontrak launchpad (SPAN blok terakhir)
```
