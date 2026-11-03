# Riset: launchpad di Elysium — Kleos, BOXA, Obol, CorePad

Dibaca langsung dari **mainnet Elysium (chain ID `99901`)** lewat RPC `rpc-live.elyspump.com`
pada blok ±278.000 (3 Nov 2026). Source code Kleos, BOXA dan Obol **tidak diverifikasi** di
explorer, jadi nama event/parameter di bawah adalah **inferensi** dari data transaksi (angka-angkanya
dicocokkan sampai ke wei). CorePad open source: [CorePad-team/corepad-contracts](https://github.com/CorePad-team/corepad-contracts).

## Ringkasan

| | Kleos "Taxed V4" | BOXA V4 | Obol | CorePad |
|---|---|---|---|---|
| Mesin harga | Uniswap V4 **fork sendiri** (PoolManager `0xb308…2490`) | Uniswap V4 **fork sendiri** (PoolManager `0x06C6…B2c4`) | Curve virtual x·y=k di factory → pool x·y=k milik Obol | Curve virtual x·y=k di `LaunchPool` |
| Fase bonding curve | Tidak ada — langsung pool V4 | Tidak ada — langsung pool V4 | Ada, graduation di ±788 jt token terjual | Ada, beku di 800 jt token terjual |
| Graduation | Tidak perlu | Tidak perlu | Otomatis ke pool internal **tanpa LP token** | Ke **HyperCore spot** (HIP-1) lewat bridge + keeper |
| Quote | HYPE native | HYPE native | WHYPE + banyak quote (KNTQ, wNVDAx, …) | HYPE native |
| MC awal | 30 HYPE | ±60,6 HYPE | ±60 HYPE (virtual 61–65 HYPE) | `graduationHype × 273/800` |
| Fee | Tax buy/sell per token (1–10%), protokol 20%, sisanya split 4 bucket | Tax buy/sell per token, protokol 30%, sisanya split 3 bucket | 1% per trade + reward holder | 1% flat ke treasury |
| Fee setelah launch | Selamanya (di hook) | Selamanya (di hook) | Ya (pool internal, lewat factory) | Tidak (pindah ke order book) |
| Pembuat LP | Helper `0x7db0…F759` | Launcher `0x00d4…D205` | — | — |

Semua token: ERC-20 standar 18 desimal, supply 1.000.000.000, tanpa owner. Ukuran bytecode:
Kleos 14.995 byte (paling kompleks), BOXA 3.920, Obol 2.933.

---

## 1. Kleos — "Taxed V4"

**Kontrak (mainnet 99901)**

| Peran | Alamat | Bukti |
|---|---|---|
| Factory v4 (`0x428f0875` launch) | `0x2dA68edFF4588A77B55A829689C382F2acB39502` | tx pembuatan ketiga token |
| PoolManager (fork V4) | `0xb308B5df891c300a5f5a5b8fdBC30108bA842490` | emit `Initialize`/`Swap`/`ModifyLiquidity`; deployer `0x4116…179b` (deployer Kleos) |
| Hook | `0xD5068e7f4e2D70d5eFbaC6fD28A8407252E1EAcC` | `claimCreatorFees`, `claimProtocolFees`; dibuat via CREATE2 deployer `0x4e59…956C` |
| Liquidity helper | `0x7db0519a39f1039678522b41FB483fC7f912F759` | menerima mint 1 M token lalu menambah likuiditas |
| Router v4 | `0xbA0b2699A9d21a2a138C494db82DFD2fFce3344c` | `buy` / `sell` |
| Vault reward-token | `0xc9EaECE8829eBCe9aF2a6E15d01b4C586B0faf7E` | dibuat oleh hook, `release`, menerima HYPE untuk dibelikan token reward |
| $KLEOS | `0x51C343Ed5131F17895991849860B61C2cb0E7e7a` | |

**PoolKey setiap token:** `currency0 = HYPE native (0x0)`, `currency1 = token`, `fee = 0`,
`tickSpacing = 200`, `hooks = 0xD506…EAcC`. Flag hook (14 bit terakhir alamat):
`BEFORE_INIT | BEFORE_ADD_LIQ | BEFORE_REMOVE_LIQ | BEFORE_SWAP | AFTER_SWAP | BEFORE_SWAP_RETURNS_DELTA | AFTER_SWAP_RETURNS_DELTA`.

**Alur launch (satu transaksi):**
1. Token mint 1 M ke helper `0x7db0…`.
2. `Initialize` pool di tick 173400 (≈ 33,9 jt token per HYPE → **MC awal 30 HYPE**; nilai `30e18`
   ada eksplisit di event `TokenCreated`).
3. `ModifyLiquidity` range `[-887200, 173400]` — seluruh supply sebagai likuiditas **satu sisi
   (token saja)** di bawah harga sekarang. Hasilnya = kurva x·y=k dengan virtual HYPE, tanpa ujung →
   **tidak ada graduation**, token sudah "di DEX" sejak blok pertama.
4. Dev buy lewat PoolManager; tax langsung dipungut hook.

**Event `TokenCreated` (`0x274c55b0`)**, kata data:
`[salt, initialMC=30 HYPE, buyTaxBps, sellTaxBps, split0, split1, split2, split3, name, symbol, metadataJSON]`

| Token | Tax buy/sell | Split (bps) | Token reward holder (event `0x7337a406`) |
|---|---|---|---|
| ELYPHANT | 1% / 1% | 0 / 5000 / 5000 / 0 | KNTQ, 50% |
| MANTE | 2% / 2% | 10000 / 0 / 0 / 0 | — |
| ECAT | 3% / 3% | 3000 / 7000 / 0 / 0 | wNVDAx, 100% |

**Rumus split yang cocok persis dengan ketiga tx:**
```
tax         = HYPE_in × taxBps
protokol    = 20% × tax                       (tinggal di hook → claimProtocolFees)
sisa        = 80% × tax, dibagi split0..3 = creator / holders / burn / (bucket ke-4)
holders     → rewardBps% dikirim ke vault 0xc9Ea… untuk dibelikan token reward (KNTQ, wNVDAx, …),
               sisanya HYPE yang bisa diklaim di hook
burn        → hook langsung swap HYPE → token dan kirim ke 0xdEaD (event 0x9974e184: HYPE, token terbakar)
```
Contoh ELYPHANT (beli 1,5673 HYPE, tax 1% = 0,015673): protokol 0,0031346; burn 0,0062692 (→ 191.813
token dibakar); holders 0,0062692 → separuh (0,0031346) ke vault KNTQ, separuh tetap di hook. ✓

Event lain di hook: `0xaa4ecfd5` (klaim creator, 154×), `0x4f8a50ec` (klaim protokol), `0xd040a1b6`
(**tax diubah** setelah launch, mis. 200→300 bps), `0x429107d0` (tax terkumpul, 8.663×).

## 2. BOXA V4 — PM + Router + Hook + Launcher

| Peran | Alamat | Bukti |
|---|---|---|
| Launcher | `0x00d4C904f74f74c6920C95E3Ee807ab3C52DD205` | `0x41811a10` launch, menerima mint 1 M |
| PoolManager (fork V4) | `0x06C63714fBf1F5753017123E2FcfdEde4540B2c4` | deployer `0x4AC8…6ee2` (deployer BOXA) |
| Hook | `0xBCc1f22d137C1D98DFa5548E4d4261D7AeE06acC` | `claim` (creator), `claimRewards` (holder), `processBuyback` |
| Router | `0x7d812380c241b331d753e8eef1cefdea4e539496` | `buy` / `sell` |
| Launcher lama | `0x8ca88b12bc89b58034c583f1a5df02f7e67d62e1` | (versi pra-V4) |

**PoolKey:** HYPE native / token, `fee = 0`, `tickSpacing = 200`, hook `0xBCc1…6acC` dengan flag
**identik** dengan Kleos. Tick awal 166200 (≈ 16,5 jt token per HYPE → **MC awal ±60,6 HYPE**),
likuiditas satu sisi `[-887200, 166200]`, LP dipegang launcher (pool tertutup).

**Event `PoolRegistered` hook (`0x719e98cb`)**: `[split0, split1, split2, flag, buyTax, sellTax]`,
tax dalam satuan 1e-6 (10000 = 1%, 50000 = 5%).

| Token | Tax | Split | Distribusi per trade (event `0x72c3c882`) |
|---|---|---|---|
| KAT | 1% | 0 / 3000 / 7000 | 0,012 tax → 0,0036 protokol (30%), 0 / 0,00252 / 0,00588 |
| ELYSX | 5% | 10000 / 0 / 0 | 0,05 tax → 0,015 protokol (30%), 0,035 ke bucket 0 |

Rumus: **protokol 30% dari tax**, sisanya dibagi 3 bucket — konsisten dengan fungsi hook
`claim` (creator), `claimRewards` (holder) dan `processBuyback` (event `0x9ff78e7c`: HYPE dipakai,
token dibeli kembali). Event `0x007dad2e` (1.005×) = akumulasi reward per pool.

## 3. Obol — curve → pool internal tanpa LP token

| Peran | Alamat |
|---|---|
| Obol v1 factory | `0x7D1904Bfb2472A0Ef97d886139A4236060e064aB` (`buy`/`sell`, `buyPool`/`sellPool`) |
| Obol v2 factory | `0xfeE823BE55EE12b8C3A76aff0bd69470aFAf2348` (`create`, `buy`, `sell`, `claimRewardsFor`) |
| WHYPE (mainnet) | `0x9F041fAd8323D7C5bf8f928AAde05B610DF34b64` |

**Curve:** x·y=k dengan virtual reserve, dalam WHYPE (factory wrap/unwrap HYPE). Contoh Helios (v1):
`virtualQuote0 = 61,152 HYPE`, `virtualToken0 = 1.078,13 jt`. Fee 1% dari sisi HYPE (`Trade`
`0x2c76e7a4`: isBuy, quoteIn, tokenOut, fee, vQuote, vToken).

**Multi-quote:** event `0x94aa979c` (`QuoteConfigured(quote, virtualReserve, enabled, isNative)`)
mendaftarkan banyak aset quote dengan virtual reserve yang di-update agar MC awal kira-kira sama
dalam USD, mis. v2: WHYPE 65,15 · KNTQ 12.275 · wNVDAx 26,33 · dan 7 aset lain.

**Graduation (Helios, tx `0x78753d0a…`, blok 180655):**
1. Buy terakhir di-*clip* (bayar 0,0028 HYPE, refund 0,497 HYPE).
2. Curve berhenti di vQuote 227,168 / vToken 290,225 jt (terjual 787,9 jt).
3. **166,016 WHYPE + 212,096 jt token** dikirim ke pool baru `0x97f4…b1ea` → event `Sync`.
4. Event `Graduated` (`0x18a56450`: token, pool, quote, token).

Harga pool = 166,016 / 212,096 jt = 7,827e-7 = harga akhir curve (kontinu). Pool `0x97f4…`:
2.724 byte, punya `getReserves`/`token0`/`token1`/`factory()` = Obol, **`totalSupply` revert →
tidak ada LP token**, likuiditas terkunci by design; trading pasca-graduation lewat
`factory.buyPool/sellPool` (event `0x290ae286`, 423×). Parameter curve cocok dengan rumus
`virtualToken = S² / (2S − N)` (S = 787,9 jt, N = 1 M).

v2 (103 token di 80k blok terakhir): belum ada yang graduate; menambah reward holder
(`claimRewardsFor`, event `0xf7a40077`) dan launch tanpa dev buy.

## 4. CorePad — curve → HyperCore (testnet)

Sumber: README/SPEC di repo, live di **testnet 99801** (`CorePadFactory 0x8547…de13`,
`Settlement 0x2cde…559C`, `ElysiumBridgeAdapter 0x9BAA…7e37`).

- `CorePadToken`: ERC-20 polos (solady), simbol `[A-Z0-9]{1,6}` unik (= ticker HyperCore), 13 ticker
  besar dicadangkan.
- `LaunchPool`: virtual x·y, `virtualHype0 = graduationHype × 273 / 800`, `virtualToken0 = 1,073e27`;
  fee 1% sisi HYPE langsung ke treasury; anti-sniper per `msg.sender` **dan** `tx.origin` (maks 1% di
  60 detik pertama); creator buy maks 2%.
- 800 jt terjual → pool **beku**, siapa pun memanggil `graduate()` → HYPE + 200 jt token ke `Settlement`.
- Keeper: register mirror di HyperEVM → `dispatch` (token lewat mirror bridge, HYPE lewat
  `ArbSys.withdrawEth`) → tunggu challenge period → klaim di Outbox → HIP-1 (beli ticker ≥ 500 HYPE di
  mainnet, genesis, `registerSpot`, ladder order simetris di sekitar `listPrice`) → `confirm`.
- Kalau belum di-dispatch 7 hari → siapa pun bisa `abort`: aset kembali, curve dibuka lagi.
- Trust: setelah bridge, keeper EOA memegang aset (belum ada `ElysiumCoreWriter`). Ticker HIP-1 mahal
  (testnet auction ±1.260–1.440 HYPE), jadi `graduationHype` harus mencakup biaya ticker.

---

## Uniswap V3 vs V4 (dengan contoh nyata di atas)

| | V3 | V4 (Kleos/BOXA) |
|---|---|---|
| Pool | Satu kontrak per pool, `factory.getPool(t0,t1,fee)` | Semua pool di satu `PoolManager`; pool = `PoolId = keccak(PoolKey)` — token Kleos/BOXA **tidak punya alamat pool** |
| Buat pool | Deploy kontrak | `initialize(key, sqrtPrice)` — murah, sekalian di tx launch |
| HYPE | Wajib WHYPE | **Native** (`currency0 = 0x0`) — terlihat di semua PoolKey di atas |
| Fee | Tier tetap ke LP | `fee = 0` di PoolKey; tax dipungut **hook** lewat `*_RETURNS_DELTA`, dibagi ke creator/holder/burn/protokol |
| Likuiditas | Siapa pun bisa tambah | `BEFORE_ADD/REMOVE_LIQ` → **pool tertutup**, hanya launcher |
| Kurva launch | Range satu sisi (gaya Clanker) | Sama (range `[MIN_TICK, tick0]`), plus logika hook |
| Saldo | Transfer per pool | *Flash accounting* + klaim ERC-6909 (hook menyimpan tax sebagai ERC-6909 id 0 = HYPE) |
| Integrasi | Router umum | Router khusus tiap launchpad (Kleos v4 router, BoxaV4Router); karena Kleos & BOXA **punya PoolManager masing-masing**, likuiditas terfragmentasi dan aggregator butuh adapter per launchpad |

## Implikasi untuk launchpad kita

1. **Model V4 hook (Kleos/BOXA/Ascend)** paling kuat untuk pendapatan berkelanjutan: tax 1–10% selamanya,
   bisa dibagi creator/holder/burn/buyback/protokol, tanpa graduation. Butuh: PoolManager V4 (deploy
   sendiri seperti mereka, atau tunggu Uniswap resmi), hook dengan alamat hasil *mining* CREATE2, router.
2. **Model curve → pool internal (Obol)** paling dekat dengan kontrak kita sekarang. Perbedaan: Obol
   tidak bergantung DEX luar (pool sendiri, tanpa LP token) dan multi-quote. Kontrak kita sudah memakai
   rumus virtual reserve yang sama.
3. **Model curve → HyperCore (CorePad)** unik tapi berat: keeper terpercaya, biaya ticker ≥ 500 HYPE,
   challenge period. Token kita sudah kompatibel mirror bridge, jadi bisa jadi tahap lanjutan.

## Reproduksi

Skrip analisis memakai ethers v6 lewat proxy (`NODE_USE_ENV_PROXY=1`):
cari mint `Transfer(0x0 → …)` token per 10k blok → ambil receipt tx pembuatan → decode event
PoolManager V4 (`Initialize 0xdd466e67`, `ModifyLiquidity 0xf208f491`, `Swap 0x40e9cecb`,
ERC-6909 `Transfer 0x1b3d7edb`) dan event kustom per word. RPC komunitas memangkas state setelah
±50k blok, tapi log tetap tersedia.
