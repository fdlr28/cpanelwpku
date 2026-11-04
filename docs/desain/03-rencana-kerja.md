# 03 · Rencana kerja bertahap

Aturan main untuk semua fase:
* Target hanya **Elysium testnet 99801** (`https://testnet-rpc.elysium.kinetiq.xyz`). Tidak ada deploy ke mainnet.
* Tidak memakai, meminta, atau menyimpan private key. Deploy ke testnet dijalankan pemilik proyek dengan
  kuncinya sendiri lewat skrip yang kami siapkan.
* Setiap fase berakhir dengan bukti yang bisa dicek (test, laporan) dan menunggu persetujuan sebelum fase berikutnya.

## Status keputusan

Keputusan D1–D6 sudah ditetapkan (lihat `02-desain-arsitektur.md` §0). Yang masih terbuka:

| # | Keputusan | Usulan | Dibutuhkan sebelum |
|---|---|---|---|
| T1 | Nama protokol dan app | ✅ Ditetapkan: protokol **Eridanos**, app **Hypelys** | — |
| T2 | Policy integrator #1 (app kita): `integratorBps` dan batas alokasi bagi pengguna app kita | `integratorBps` 3000; alokasi pengguna ≤ 20% sesuai batas protokol; tampilkan peringatan jelas bila instan | Fase 5 |
| T3 | Surcharge dalam token: dibakar atau ke protokol | Dibakar (protokol tidak menumpuk token yang diluncurkan); surcharge dalam quote ke protokol | Fase 3 |

### Usulan nama (T1)

Dicek 4 Nov 2026: 0 repo GitHub dengan nama itu, nama paket npm masih kosong, dan tidak ada proyek kripto
bernama sama di pencarian web.

| Lapis | Nama | Makna | Cek nama |
|---|---|---|---|
| Protokol (setara Doppler) | **Eridanos** | Sungai yang mengalir melewati padang Elysium dalam mitologi Yunani (Vergilius, *Aeneis* VI). Sungai = likuiditas (*liquid*, Hyperliquid) yang dibawa satu jalur bersama untuk semua app di Elysium, di atas HyperEVM | GitHub 0, npm kosong, web tidak ada |
| App (setara Bankr) | **Hypelys** | HYPE (gas dan aset Hyperliquid) + Elysium; pendek dan mudah diucapkan | GitHub 1 repo tak terkait, npm kosong, web tidak ada |
| Alternatif app | Hypelysium | Bentuk panjang HYPE + Elysium | GitHub 0, npm kosong |
| Alternatif app | Elymint | Elysium + *mint* (pembuatan token EVM) | GitHub 0, npm kosong; mirip "Elys Network" (Cosmos, tidak terkait) |

Catatan: nama berawalan "Elys…" bisa tertukar dengan Elys Network dan Elysium milik Vulcan Forged; "Eridanos" dan
"Hypelys" tidak punya masalah itu. Cek merek dagang dan domain belum dilakukan.

## Fase 0 · Persetujuan desain

**Hasil:** `01-riset-model-acuan.md`, `02-desain-arsitektur.md` (revisi 2), dokumen ini.

**Selesai bila** revisi 2 disetujui. ✅ Disetujui 4 Nov 2026.

## Fase 1 · Toolchain dan fondasi

* Hardhat yang sudah ada + solcjs. Compiler 0.8.26 untuk kode yang berinteraksi langsung dengan v4-core;
  `evmVersion: cancun`.
* PoolManager di-deploy dari artifact kanonik `@uniswap/v4-core@1.0.2` (`out/PoolManager.sol/PoolManager.json`,
  24.195 byte), tanpa kompilasi ulang. Router uji dan `V4Quoter` dari `@uniswap/v4-periphery`.
* Semua kontrak yang butuh PoolManager menerimanya sebagai parameter konstruktor (`immutable`); test memakai
  dua PoolManager berbeda untuk membuktikan tidak ada alamat yang di-hardcode.
* Helper *mining* alamat hook (CREATE2) untuk bit: `beforeInitialize`, `beforeAddLiquidity`, `beforeSwap`,
  `beforeSwapReturnsDelta`, `afterSwap`, `afterSwapReturnsDelta`; test yang memastikan bit izinnya tepat.
* Kontrak lama MVP dipindah ke `contracts/legacy/`; tidak dihapus.

**Selesai bila** test lokal bisa membuat pool V4 dengan hook dummy di alamat hasil *mining*, pada PoolManager yang
alamatnya diberikan saat deploy.

✅ **Selesai 4 Nov 2026** (`test/v2/foundation.test.js`, 9 test). Hasil:
* `hardhat.config.js`: dua compiler solcjs dari npm (0.8.28 untuk kode lama, 0.8.26 untuk v2), hardfork `cancun`.
* PoolManager di-deploy dari artifact `@uniswap/v4-core@1.0.2` dan dibuktikan identik byte-per-byte dengan
  artifact (bagian `immutable` di-mask) — `scripts/lib/v4.js`.
* `contracts/v2/libraries/CurveHookFlags.sol`: satu sumber izin hook, flag `0x28CC`.
* `contracts/v2/utils/HookDeployer.sol` + `scripts/lib/hookMiner.js`: CREATE2 dengan salt hasil *mining*; alamat
  on-chain = alamat off-chain.
* `contracts/v2/mocks/DummyCurveHook.sol`: PoolManager sebagai parameter konstruktor; menolak di-deploy pada alamat
  tanpa bit yang benar; menolak dipakai lewat PoolManager lain.
* Kontrak MVP dipindah ke `contracts/legacy/`; 21 test lamanya tetap lulus.

## Fase 2 · Token, vesting, konfigurasi, registry

* `EridanosToken`, `VestingVault`, `ProtocolConfig` (termasuk validasi preset kurva), `IntegratorRegistry`
  (mode A/B, EIP-712, EIP-1271, nonce, payout, policy tertunda, mode allowlist), `TimelockController`.
* Test unit + fuzz:
  * vesting: tidak cair sebelum cliff, linear setelahnya; `duration = 0` cair penuh di tx launch;
  * batas: alokasi > 20%, dev buy > 10%, penerima > 3, `cliff > duration` selalu ditolak;
  * policy integrator yang lebih longgar dari batas protokol ditolak; perubahan policy baru berlaku setelah 24 jam;
  * tanda tangan tidak bisa dipakai ulang, dipakai pemanggil lain, atau dipakai di chain lain;
  * allowlist: saat menyala, integrator yang belum disetujui tidak bisa dipakai untuk launch; mode C tetap jalan;
    pool lama tetap membayar integrator lama.

**Selesai bila** semua test lulus dan batas di `02 §4` dan `§10.3` terbukti di test.

✅ **Selesai 4 Nov 2026** (`test/v2/registry.test.js`, `test/v2/token-vault-config.test.js`, 34 test). Hasil:
* `contracts/v2/libraries/EridanosConstants.sol`: semua batas protokol sebagai konstanta kode.
* `EridanosToken` (nama dipilih agar tidak bentrok dengan `LaunchToken` lama): supply 1e27 sekali mint, tanpa owner/mint/pajak, metadata immutable.
* `VestingVault`: cliff di dalam jendela vesting, linear, `duration = 0` dibayar langsung tapi tetap tercatat; menolak token fee-on-transfer.
* `ProtocolConfig`: quote, preset kurva append-only dengan validasi (urutan band, spacing, total bps, rentang tick,
  likuiditas per tick untuk kedua urutan token), treasury, guardian.
* `IntegratorRegistry`: identitas = `msg.sender`; akun pindah 2 langkah; signer/payout; policy ditunda 24 jam dan
  dibatasi konstanta; allowlist; suspend; pause pendaftaran oleh guardian; mode B EIP-712 + EIP-1271 dengan nonce acak
  sekali pakai, terikat ke chain, core, caller, creator, dan hash parameter.
* `EridanosTimelock` (OpenZeppelin `TimelockController`): perubahan admin hanya setelah jeda.

Koreksi data: fixture kurva memakai bentuk Ascend yang benar (15 band, total 10.000 bps, puncak 200.000 tick); dokumen
riset dan laporan PDF yang sebelumnya menulis 14 band sudah diperbaiki.

## Fase 3 · Mesin pool: `CurveHook` + `FeeDistributor` + `LaunchCore`

* Penanaman band satu sisi, fee dasar 1% (override), surcharge anti-sniper lewat *return delta*
  (exact-input dan exact-output), penolakan likuiditas luar, `collect`, split 20 / integrator / creator, klaim,
  pengalihan peran creator, pause launch.
* Simulasi untuk memilih **preset kurva awal** untuk HYPE dan USDC (harga awal, jumlah band, porsi), lalu
  didokumentasikan sebelum dikunci.
* Test khusus anti-sniper:
  * `f(t)` per detik dari `block.timestamp`, termasuk banyak blok dengan timestamp sama;
  * total fee efektif = `f(t)` untuk beli dan jual, exact-input dan exact-output, kedua urutan mata uang;
  * surcharge tidak pernah tercatat untuk creator/integrator;
  * creator yang membeli lewat router di detik pertama membayar surcharge penuh;
  * dev buy di tx launch hanya membayar 1%.
* Test invarian:
  * konservasi supply; likuiditas band tidak pernah turun;
  * total klaim ≤ total fee dasar, sisa pembulatan ke creator;
  * `protocolBps` selalu 2000 dan `creatorBps = 8000 − integratorBps`;
  * porsi dan jadwal fee tidak berubah setelah launch; saldo `LaunchCore` = 0 setelah launch.

**Selesai bila** satu launch lengkap (mode A, B, C; dengan dan tanpa alokasi instan; dengan dev buy) berjalan di
jaringan lokal, termasuk swap beli/jual di dalam dan di luar jendela anti-sniper, `collect`, dan tiga klaim, dengan
angka yang cocok sampai wei.

## Fase 4 · Uji serangan dan review internal

Skenario yang wajib gagal:
* integrator palsu: memakai id orang lain tanpa menjadi `account` atau tanpa tanda tangannya;
* replay tanda tangan, salah chain, salah caller;
* bypass batas: alokasi > 20%, dev buy > 10%, dev buy kedua di luar tx launch tanpa surcharge;
* menghindari surcharge lewat exact-output, swap multi-hop, atau router lain;
* menambah likuiditas dari luar ke pool kita; membuat pool palsu dengan hook kita;
* menarik LP;
* reentrancy saat klaim;
* front-run salt token;
* sniping di detik 0.

Juga: review kode internal dengan checklist dari `02 §10`, laporan gas, dan ukuran kontrak (< 24 KB).

**Selesai bila** semua skenario gagal sebagaimana mestinya dan laporan review tidak menyisakan temuan tinggi.

## Fase 5 · Lapis app

* `AppRouter` (integrator #1), frontend baru (menggantikan frontend MVP; tetap statis, cocok untuk cPanel), indexer
  sederhana dari event, SDK TypeScript kecil + contoh integrasi untuk pihak ketiga (mode A dan B).
* Halaman token menampilkan alokasi creator (instan/vesting), dev buy, integrator (id + alamat), dan pembagian fee.
* Uji E2E di browser pada jaringan lokal: daftar integrator → launch → dev buy → trading → klaim tiap peran.

**Selesai bila** E2E lulus untuk app kita dan untuk contoh integrator pihak ketiga.

## Fase 6 · Testnet 99801

Prasyarat:
* RPC testnet diizinkan di jaringan sesi (saat ini diblokir dari lingkungan riset).
* HYPE testnet di dompet deployer milik pemilik proyek.

Isi fase:
* Skrip deploy dengan *dry-run*; alamat PoolManager dibaca dari konfigurasi deploy.
* Urutan deploy: PoolManager → Timelock → config → registry → vault → hook (mined) → distributor → core → AppRouter.
* Serah terima owner PoolManager ke Timelock dengan `protocolFeeController = 0`.
* Verifikasi source di explorer testnet.
* Uji asap: beberapa launch nyata dalam mode A/B/C, swap di dalam dan di luar jendela anti-sniper, klaim.

**Selesai bila** alamat terdokumentasi di `deployments/99801.json` dan semua uji asap lulus di testnet.

## Fase 7 · Sebelum mainnet (di luar cakupan sekarang)

Butuh persetujuan terpisah:
* audit eksternal;
* pilihan PoolManager: deployment resmi Uniswap V4 bila sudah ada, atau keputusan lisensi (`02 §5.1`);
* nyalakan mode allowlist bila diperlukan;
* tinjau ulang batas alokasi instan (`02 §4.2`);
* multisig produksi, jeda Timelock 48 jam.
