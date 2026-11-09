# CLAUDE.md

Konteks untuk Claude Code di repo ini. Status terkini dan pekerjaan berikutnya: **`CATATAN-LANJUTAN.md`** (baca dulu).
Pemilik proyek menulis dalam bahasa Indonesia; jawab dan tulis dokumen dalam bahasa Indonesia.

## Proyek

Launchpad token di **Elysium** (L2 Arbitrum Orbit milik Kinetiq, gas HYPE, settle ke HyperEVM):

* **Eridanos**: protokol peluncuran terbuka untuk banyak app (setara Doppler), di atas Uniswap v4 dengan PoolManager sendiri,
  kurva 15 band ala Ascend, fee 1% (protokol 20% tetap, integrator ≤30% dari bagian creator), anti-sniper 90%→1% dalam 10 detik.
* **Provenalt**: app launchpad kita, integrator #1 (dulu bernama Hypelys; kontrak router yang ter-deploy tetap bernama
  `HypelysRouter` karena source-nya sudah terverifikasi).

Desain dan keputusan: `docs/desain/` (02 arsitektur, 03 rencana kerja + status, 04 review keamanan, 05 runbook testnet).

## Batasan dari pemilik proyek

* Target **Elysium testnet 99801** saja. **Jangan deploy ke mainnet.** Skrip menolak chain selain 99801/31337/998.
* **Jangan pakai, minta, cetak, atau commit private key.** `.env` (berisi `PRIVATE_KEY` milik pemilik proyek) tidak
  di-commit dan jangan ditampilkan isinya. Transaksi on-chain dari dompet pemilik dijalankan oleh pemilik sendiri.
* Mainnet butuh persetujuan terpisah (fase 7: audit eksternal, multisig, Timelock 48 jam).

## Struktur

| Folder | Isi |
|---|---|
| `contracts/v2/` | protokol Eridanos (Solidity 0.8.26, viaIR, EVM cancun); `app/HypelysRouter.sol` = router Provenalt |
| `contracts/` (lainnya) | MVP lama (0.8.28), tidak dipakai lagi |
| `test/v2/` | 112 test Hardhat |
| `scripts/` | deploy, uji asap testnet, serah terima admin, verifikasi Sourcify, bridge USDC, paket frontend |
| `sdk/eridanos-sdk.js` | SDK untuk integrator (salinannya di `frontend/eridanos-sdk.js`, harus disamakan) |
| `frontend/` | website statis Provenalt (tanpa build) |
| `indexer/` | indexer + REST API (Node + Postgres) untuk Railway; berdiri sendiri, punya `package.json` sendiri |
| `deployments/` | alamat dan hasil uji testnet |

## Perintah

```bash
npm install                      # root (Hardhat). Kompiler solc dari npm (solcjs), tidak perlu unduhan.
npx hardhat test                 # 112 test
npx hardhat run scripts/<x>.js --network elysiumTestnet     # testnet (butuh PRIVATE_KEY di .env, CONFIRM=yes untuk tx)
npx hardhat run scripts/<x>.js --network hyperevmTestnet    # HyperEVM testnet 998 (bridge)
bash scripts/package-frontend.sh                            # dist/provenalt-frontend.zip (INDEXER_URL=... opsional)
cd indexer && npm install && npm test                       # e2e indexer: butuh Postgres + chain lokal, lihat indexer/README.md
```

Chain lokal untuk uji: `npx hardhat node`, lalu `scripts/deploy-local-v2.js`, `scripts/smoke-testnet-v2.js`,
`scripts/smoke-usdc-v2.js` dengan `--network localhost`.

## Hal yang perlu diingat

* RPC publik testnet membatasi request (error -32017 / HTTP 429): jangan kirim banyak request sekaligus; frontend dan
  indexer memakai provider dengan antrean. `eth_getLogs` boleh rentang jutaan blok bila difilter alamat (±12 blok/detik).
* Log RPC Elysium menyertakan `blockTimestamp`.
* Explorer testnet: `https://explorer-elysium-testnet.t.conduit.xyz`; verifikasi source lewat Sourcify Conduit
  (`node scripts/verify-sourcify.js`, tanpa kunci).
* Setiap perubahan `.sol` mengubah bytecode: kontrak yang sudah ter-deploy tidak ikut berubah dan source-nya tidak lagi
  cocok dengan verifikasi. Jangan ubah file `.sol` yang sudah ter-deploy tanpa rencana deploy ulang.
* Commit ke branch kerja yang sedang dipakai; jangan push ke `main` tanpa izin.
