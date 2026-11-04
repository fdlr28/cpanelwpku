# 03 · Rencana kerja bertahap

Aturan main untuk semua fase:
* Target hanya **Elysium testnet 99801** (`https://testnet-rpc.elysium.kinetiq.xyz`). Tidak ada deploy ke mainnet.
* Tidak memakai, meminta, atau menyimpan private key. Deploy ke testnet dijalankan pemilik proyek dengan
  kuncinya sendiri lewat skrip yang kami siapkan.
* Setiap fase berakhir dengan bukti yang bisa dicek (test, laporan) dan menunggu persetujuan sebelum fase berikutnya.

## Fase 0 · Persetujuan desain (sekarang)

**Hasil:** `01-riset-model-acuan.md`, `02-desain-arsitektur.md`, dokumen ini.

**Selesai bila** keputusan di bagian "Keputusan yang dibutuhkan" di bawah dijawab.

## Fase 1 · Toolchain dan fondasi

* Hardhat yang sudah ada + solcjs. Compiler 0.8.26 untuk kode yang berinteraksi langsung dengan v4-core;
  `evmVersion: cancun`.
* PoolManager di-deploy dari artifact kanonik `@uniswap/v4-core@1.0.2` (`out/PoolManager.sol/PoolManager.json`,
  24.195 byte), tanpa kompilasi ulang. Router uji dan `V4Quoter` dari `@uniswap/v4-periphery`.
* Helper *mining* alamat hook (CREATE2) dan test yang memastikan bit izin sesuai.
* Kontrak lama MVP dipindah ke `contracts/legacy/`; tidak dihapus.

**Selesai bila** test lokal bisa membuat pool V4 kosong dengan hook dummy di alamat hasil *mining*.

## Fase 2 · Token, vesting, konfigurasi, registry

* `LaunchToken`, `VestingVault`, `ProtocolConfig` (termasuk validasi preset kurva), `IntegratorRegistry`
  (mode A/B, EIP-712, EIP-1271, nonce, policy tertunda), `TimelockController`.
* Test unit + fuzz:
  * vesting tidak pernah cair sebelum cliff, linear setelahnya;
  * durasi 0 dan cliff 0 dengan alokasi > 0 selalu ditolak;
  * batas alokasi/dev buy, perubahan policy hanya berlaku setelah 24 jam;
  * tanda tangan tidak bisa dipakai ulang, dipakai pemanggil lain, atau dipakai di chain lain.

**Selesai bila** semua test lulus dan batas kebijakan dari `02 §4` dan `§10.3` terbukti di test.

## Fase 3 · Mesin pool: `CurveHook` + `FeeDistributor` + `LaunchCore`

* Penanaman band satu sisi, jadwal fee anti-sniper, penolakan likuiditas luar, `collect`, split, klaim,
  pengalihan peran creator, pause launch.
* Simulasi untuk memilih **preset kurva awal** untuk HYPE dan USDC (harga awal, jumlah band, porsi), lalu
  didokumentasikan sebelum dikunci.
* Test invarian:
  * konservasi supply;
  * likuiditas band tidak pernah turun;
  * total klaim ≤ total fee, sisa pembulatan ke creator;
  * porsi dan jadwal fee tidak berubah setelah launch;
  * saldo `LaunchCore` = 0 setelah launch.

**Selesai bila** satu launch lengkap (mode A, B, C) berjalan di jaringan lokal, termasuk dev buy, swap
beli/jual, `collect`, dan tiga klaim, dengan angka yang cocok sampai wei.

## Fase 4 · Uji serangan dan review internal

Skenario yang wajib gagal:
* integrator palsu: mengisi id orang lain tanpa menjadi `account` atau tanpa tanda tangannya;
* replay tanda tangan, salah chain, salah caller;
* bypass kebijakan: alokasi instan, alokasi > batas, dev buy > batas, beneficiary berlebih;
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
* Uji E2E di browser pada jaringan lokal: daftar integrator → launch → dev buy → trading → klaim tiap peran.

**Selesai bila** E2E lulus untuk app kita dan untuk contoh integrator pihak ketiga.

## Fase 6 · Testnet 99801

Prasyarat:
* RPC testnet diizinkan di jaringan sesi (saat ini diblokir dari lingkungan riset).
* HYPE testnet di dompet deployer milik pemilik proyek.

Isi fase:
* Skrip deploy dengan *dry-run*.
* Urutan deploy: PoolManager → Timelock → config → registry → vault → hook (mined) → distributor → core → AppRouter.
* Serah terima owner PoolManager ke Timelock dengan `protocolFeeController = 0`.
* Verifikasi source di explorer testnet.
* Uji asap: beberapa launch nyata dalam mode A/B/C, swap, klaim.

**Selesai bila** alamat terdokumentasi di `deployments/99801.json` dan semua uji asap lulus di testnet.

## Fase 7 · Sebelum mainnet (di luar cakupan sekarang)

Audit eksternal, keputusan lisensi PoolManager (`02 §5.1`), multisig produksi, jeda Timelock 48 jam.
Butuh persetujuan terpisah.

---

## Keputusan yang dibutuhkan sebelum fase 1

| # | Keputusan | Usulan |
|---|---|---|
| 1 | Mesin pool | Uniswap V4, PoolManager sendiri di testnet dari bytecode kanonik |
| 2 | Pembagian fee protokol / integrator / creator | 20 / 30 / 50; tanpa integrator → 50 / 0 / 50 |
| 3 | Jadwal fee | Mulai 90%, turun dalam 10 detik, lalu 1% selamanya |
| 4 | Kebijakan supply | Supply 1 miliar; alokasi 0% atau ≤ 10% dengan cliff ≥ 30 hari + vesting ≥ 180 hari; dev buy ≤ 5% |
| 5 | Kebijakan app kita | 0% atau 5% (cliff 30 hari, vesting 1 tahun); dev buy ≤ 3% |
| 6 | Quote | HYPE native dan USDC testnet (`0x7D29…47b2`) |
| 7 | Pendaftaran integrator | Permissionless di testnet; bond/persetujuan untuk mainnet diputuskan nanti |
| 8 | Mode atribusi | A (caller) dan B (signed) keduanya didukung |
| 9 | Jeda Timelock | Testnet 1 jam; policy integrator 24 jam |
| 10 | Nama protokol dan app | Nama kerja "ELP"; nama final dari Anda |
