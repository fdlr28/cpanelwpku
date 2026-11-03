# Riset: launchpad yang sudah jalan di Elysium (Kleos, BOXA, Obol)

> Status: **belum diverifikasi on-chain.** Explorer (elyscan.live, obol.world), explorer resmi
> (dilindungi Vercel bot-checkpoint) dan semua RPC mainnet masih diblokir dari lingkungan riset.
> Alamat di bawah berasal dari pernyataan tim masing-masing di issue GitHub publik
> (MetaMask/eth-phishing-detect). Cek ulang di explorer sebelum dipakai.

## Fakta jaringan

- Token-token yang diberikan ada di **mainnet Elysium, chain ID `99901`** (private/early mainnet;
  docs resmi masih menulis "coming soon"). Testnet = `99801`.
- RPC komunitas (dari boxa.club/developers, tolok ukur 2 Nov 2026): `rpc.thekleos.xyz/rpc`,
  `rpc-live.boxa.club` (batch maks 20), `rpc-live.elyspump.com`. Semua memangkas state historis
  setelah ±50k blok (≈1,4 jam di blok 100 ms) → butuh archive node/indexer untuk data historis.
- Uniswap belum resmi live, tapi launchpad sudah memakai **Uniswap V4 PoolManager** dan
  **Permit2** (`0x000000000022D473030F116dDEE9F6B43aC78BA3`).

## Token sampel

| Launchpad | Token |
|---|---|
| Kleos v4 | `0xcc9738cb8edfe24fcfd348529c591341b9758314`, `0x60c9bd4c4245ceff1473b43f9629dc7a9c17e415`, `0x5f471e53eda2110981b5ac6a1ee7e7ae5b62b21b` |
| BOXA v4 | `0x9b82733f601dc585a75af5ccb360af12f9afff3d`, `0x3b3004c1ff88b9245193af9c1cf3bceb42623f5a` |
| Obol | `0x792aa7771e4e1bd58f84631c915ae98aef45277e`, `0xfEe05805D934A63Ae9fba3b2B20FA93400c120f6` |

## Kontrak yang diklaim tiap launchpad (chain 99901)

**Kleos** ([issue #308584](https://github.com/MetaMask/eth-phishing-detect/issues/308584))

| Kontrak | Alamat | Fungsi |
|---|---|---|
| Kleos v4 router | `0xbA0b2699A9d21a2a138C494db82DFD2fFce3344c` | jual/beli coin v4 (pool HYPE) |
| Kleos v5 router | `0xB15D5A0159Fc11BF1a1F9E383b0DE76440Ec6FC3` | coin v5 (dulu pakai EIP-2612 permit) |
| KleosSwap router | `0x03c291D55Cc178B8Fc3e20607125b8F6e9D12687` | coin "classic" (versi lama) |
| $KLEOS pair router | `0x819741D02baFa76f0eEDF9EE8eDAb2a3EcCD37de` | coin yang dipasangkan dengan $KLEOS |
| KleosStaking | `0xdd9Ece123c8c9EE95122B412871C52987E4aBcdD` | staking $KLEOS |

Fitur: tombol "Claim" untuk holder rewards & creator fee dari kontrak coin itu sendiri.

**BOXA** ([issue #307359](https://github.com/MetaMask/eth-phishing-detect/issues/307359))

| Kontrak | Alamat |
|---|---|
| BoxaV4Hook | `0xbcc1f22d137c1d98dfa5548e4d4261d7aee06acc` |
| BoxaV4Launcher | `0x00d4c904f74f74c6920c95e3ee807ab3c52dd205` |
| BoxaV4Router | `0x7d812380c241b331d753e8eef1cefdea4e539496` |
| BoxaLauncher (versi lama) | `0x8ca88b12bc89b58034c583f1a5df02f7e67d62e1` |

**Obol** ([issue #307261](https://github.com/MetaMask/eth-phishing-detect/issues/307261)):
satu kontrak untuk launch & trade, `0x84941cb4495fF9c79Af81eBCD46124809E65f7Ec`. Punya trading
API untuk bot; 80% revenue untuk buyback & burn $OBOL; fee coin bisa diarahkan ke holder, creator,
atau posisi perp di Hyperliquid (menurut media).

⚠️ Ketiga domain (thekleos.xyz, boxa.pro/boxa.club, obol.world) pernah masuk blocklist phishing
MetaMask; ketiganya mengajukan banding. Jangan approve apa pun ke alamat yang belum dicek.

### Membaca BoxaV4Hook dari alamatnya

Di Uniswap V4, izin hook tersandi di 14 bit terakhir alamat hook. `0x…6acc` → flags `0x2acc`:

| Flag aktif | Artinya untuk launchpad |
|---|---|
| `BEFORE_INITIALIZE` | Hanya launcher BOXA yang boleh membuat pool dengan hook ini |
| `BEFORE_ADD_LIQUIDITY`, `BEFORE_REMOVE_LIQUIDITY` | **Pool tertutup**: pihak luar tidak bisa tambah/tarik likuiditas (model "closed hook pool" yang juga dipakai Ascend) |
| `BEFORE_SWAP`, `AFTER_SWAP` | Logika di setiap swap (fee, anti-sniper, cek graduation, dsb.) |
| `BEFORE_SWAP_RETURNS_DELTA`, `AFTER_SWAP_RETURNS_DELTA` | Hook bisa **mengubah jumlah swap**: memungut fee langsung dari swap, atau menjalankan kurva harga sendiri (bonding curve di dalam hook) |

Tidak aktif: donate, after-add/remove-liquidity, after-initialize.

## Uniswap V3 vs V4 — yang relevan untuk launchpad

| | V3 | V4 |
|---|---|---|
| Arsitektur | Satu **kontrak per pool**, dibuat Factory (`createPool`, event `PoolCreated`) | **Satu kontrak `PoolManager`** (singleton) memegang semua pool |
| Identitas pool | Alamat pool (`factory.getPool(t0, t1, fee)`) | `PoolId = keccak256(PoolKey)`; `PoolKey = (currency0, currency1, fee, tickSpacing, hooks)`. Pool **tidak punya alamat sendiri** |
| Membuat pool | Deploy kontrak (mahal) | `PoolManager.initialize(key, sqrtPriceX96)` → event `Initialize` (murah) |
| Likuiditas | Concentrated (rentang tick), posisi = NFT `NonfungiblePositionManager` | Sama-sama concentrated, posisi lewat `PositionManager` (NFT) + Permit2 |
| Native coin | Wajib wrapped (WHYPE) | **HYPE native** langsung (`currency = address(0)`) |
| Fee | Tier tetap (0,01/0,05/0,3/1%) | Bebas, bisa **dinamis** (diatur hook per swap) |
| Logika kustom | Tidak ada | **Hooks**: kode sebelum/sesudah initialize, add/remove liquidity, swap, donate; bisa return delta |
| Eksekusi | Transfer token di setiap pool | *Flash accounting*: `unlock()` → callback → saldo net di-*settle* di akhir. Multi-hop jauh lebih hemat |
| Event swap | `Swap` di alamat pool | `Swap(id, sender, amount0, amount1, …)` di PoolManager |
| Router | SwapRouter umum | Biasanya router khusus/Universal Router yang memanggil `unlock` |

**Dampaknya untuk launchpad:**
- **V3** (gaya Clanker lama): launchpad membuat pool lalu menaruh likuiditas *single-sided* (hanya
  token) di atas harga awal. Rentang tick berfungsi sebagai "bonding curve". NFT LP dikunci di locker,
  dan fee LP dibagi creator/protokol lewat `collect()`. Siapa pun tetap bisa menambah likuiditas
  dan trade lewat router mana saja, dan fee hanya bisa dari tier LP.
- **V4** (Kleos v4, BOXA v4, Ascend): hook bisa **menutup pool**, **memungut fee creator selamanya**
  di setiap swap (misal 1% seperti Ascend), membuat kurva harga sendiri, menambah anti-sniper,
  dan memakai HYPE native tanpa WHYPE. Biaya buat pool juga sangat murah karena tidak perlu
  deploy kontrak. Konsekuensinya: aggregator/router umum harus paham PoolKey dan hook-nya, dan
  alamat hook harus di-*mine* (CREATE2) agar bit izinnya cocok.

## Cara verifikasi on-chain (begitu RPC/explorer bisa diakses)

1. `eth_getCode` tiap token → cek apakah ERC-20 standar atau punya logika tambahan (reward holder, pajak).
2. Ambil tx pembuatan token → kontrak pembuatnya (= factory/launcher).
3. Cari event `Initialize` di PoolManager dengan `currency0/1` = token → dapat `PoolKey`:
   fee, tickSpacing, dan **alamat hook**. Decode flag hook seperti di atas.
4. Baca kode hook/launcher yang terverifikasi di explorer: rumus fee, pembagian creator/protokol,
   syarat graduation, siapa yang boleh add liquidity.
5. Untuk Obol: cek apakah memakai PoolManager V4 atau curve internal di `0x84941c…`.
