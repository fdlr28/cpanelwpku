# 04 · Review internal fase 4

Tanggal: 4 Nov 2026. Lingkup: kontrak v2 di `contracts/v2/` (commit fase 3) terhadap checklist
`02-desain-arsitektur.md` §10. Ini **review internal, bukan audit**; audit eksternal tetap wajib sebelum mainnet.

## 1. Ringkasan

* 102 test lulus (`npx hardhat test`): 21 kontrak lama, 9 fondasi, 34 fase 2, 21 fase 3, **17 skenario serangan** fase 4.
* Tidak ada temuan **tinggi** atau **kritis** yang terbuka.
* Tiga temuan **rendah** dan satu konsekuensi desain (**sedang**, sudah diterima pemilik proyek) dicatat di §3.

## 2. Skenario serangan (`test/v2/attacks.test.js`)

| Skenario | Hasil |
|---|---|
| Pemanggil tak terdaftar mencoba mendapat atribusi integrator | Jatuh ke mode C (`integratorId = 0`) |
| Peniru mendaftar dengan nama sama ("Provenalt") | Mendapat id sendiri (2), tidak pernah id 1 |
| Replay `LaunchIntent` untuk peluncuran kedua | `NonceAlreadyUsed` |
| Core palsu memakai intent | `NotCore` |
| Alokasi > 20% dipecah ke beberapa penerima; dev buy > 10% | `AllocationNotAllowed`, `DevBuyNotAllowed` |
| Memanggil `seed` di luar core (dev buy kedua tanpa surcharge) | `NotCore` |
| Jalur mint tersembunyi | `totalSupply` tetap 1e27 setelah trading |
| Sniping di **blok yang sama** dengan launch | Kena fee 90% penuh |
| Jual exact-output di jendela | Surcharge dalam token, dibakar saat `collect` |
| Swap sangat kecil untuk lolos surcharge | Surcharge tepat sesuai rumus |
| Menarik posisi LP hook lewat router | Revert; likuiditas tidak berubah |
| Fungsi tarik likuiditas / admin di hook | Tidak ada (daftar fungsi dicek di test) |
| `bind` ulang hook/distributor | `AlreadyBound` |
| Creator berupa kontrak yang re-enter `claimCreator` | Re-entry gagal; dibayar tepat sekali |
| Pihak lain memanggil `credit`/`registerPool` | `NotHook`/`NotCore` |
| Mengalihkan klaim protokol/integrator | Selalu ke treasury / payout di registry |
| Pause memblokir swap, `collect`, klaim | Tidak; pause hanya untuk launch baru |

## 3. Temuan

| # | Tingkat | Temuan | Status / mitigasi |
|---|---|---|---|
| R-1 | Sedang (desain) | Keputusan D4: creator bisa memegang hingga 30% supply sejak detik pertama (alokasi instan 20% + dev buy 10% tanpa surcharge) | Diterima pemilik proyek. Diungkap di `Launched` (`allocBps`, `instantAllocation`, `devBuyTokens`) dan wajib ditampilkan UI. Integrator bisa memperketat lewat policy. Ditinjau ulang sebelum mainnet |
| R-2 | Rendah | Surcharge exact-input dihitung dari jumlah **yang ditentukan**. Bila router memasang batas harga sehingga swap hanya terisi sebagian, swapper tetap membayar surcharge penuh | Hanya terjadi di jendela 10 detik dan atas pilihan swapper. `AppRouter` (fase 5) tidak memasang batas harga yang memotong swap di jendela; UI memperingatkan. Opsi fase berikutnya: hitung surcharge exact-input dari jumlah aktual |
| R-3 | Rendah | Creator berupa kontrak yang menolak HYPE dan tidak bisa memanggil `transferCreator` membuat fee creator tidak bisa diambil | Klaim lain tidak terpengaruh. UI menyarankan creator EOA atau kontrak yang bisa menerima HYPE |
| R-4 | Rendah | `ProtocolConfig.setQuote` tidak memeriksa apakah token quote bertransfer tepat (tanpa pajak/rebase). Quote seperti itu akan merusak dev buy dan akuntansi | Tanggung jawab tata kelola: hanya HYPE native dan USDC kanonik yang diizinkan. `VestingVault` sendiri sudah menolak token tidak tepat |
| I-1 | Info | Klaim surcharge quote (ERC-6909) dikumpulkan bersama untuk semua pool; atribusi per pool hanya lewat event `SurchargeCharged` | Tidak berdampak dana: semuanya milik protokol |
| I-2 | Info | Debu pembulatan seeding (±3.400 wei dari 1e27) dibakar | Diuji di invarian supply |
| I-3 | Info | Refund dev buy mode A dikirim ke `msg.sender` (router integrator) | `AppRouter` harus meneruskan refund ke pengguna (fase 5) |
| I-4 | Info | `block.timestamp` Elysium beresolusi 1 detik: ±10 blok pertama berbagi fee 90% | Sesuai desain; diuji sniping di blok yang sama |
| I-5 | Info | Router uji v4-core (`PoolSwapTest`, `PoolModifyLiquidityTest`, `TestERC20`, lisensi UNLICENSED) hanya dipakai di test | Tidak ikut deploy |
| I-6 | Info | Owner PoolManager testnet harus dipindah ke Timelock dengan `protocolFeeController = 0` | Bagian skrip deploy fase 6 |
| I-7 | Rendah (fase 5, sudah diperbaiki) | Di mode A semua pengguna router berbagi namespace salt token (`msg.sender` di core = router), sehingga penyerang bisa mendahului salt pengguna dan membuat transaksinya gagal | `HypelysRouter` mengikat salt ke pengguna (`userSalt = keccak(user, salt)`); diuji di `app.test.js`. Router integrator lain sebaiknya melakukan hal yang sama (dicatat di contoh dan SDK) |
| I-8 | Rendah (fase 5, sudah diperbaiki) | Beli HYPE yang melebihi sisa kurva terisi sebagian; sisa HYPE akan tertahan di router | `HypelysRouter.buy` mengembalikan sisa |

## 4. Checklist `02 §10`

| Butir | Status |
|---|---|
| Tanpa proxy, tanpa `delegatecall` dinamis, tanpa *arbitrary call* | ✅ |
| Reentrancy guard transien di core, vault, distributor | ✅ |
| Quote hanya dari whitelist | ✅ (lihat R-4) |
| Salt token terikat pemanggil | ✅ (`predictToken` diuji) |
| EIP-712: chainId, verifyingContract, nonce sekali pakai, deadline, caller, core, EIP-1271 | ✅ |
| Hanya `block.timestamp`, tanpa `block.number` | ✅ (tidak ada `block.number` di `contracts/v2`) |
| Porsi protokol selalu 20%, creator = 80% − integrator | ✅ (konstanta + test split) |
| Surcharge tidak pernah ke creator/integrator | ✅ |
| Likuiditas band tidak pernah turun | ✅ |
| Saldo token `LaunchCore` = 0 setelah launch | ✅ |
| Pause tidak menyentuh swap/klaim/vesting | ✅ |
| Semua kontrak < 24 KB | ✅ (terbesar `LaunchCore` 16,6 KB) |

## 5. Gas (jaringan lokal, `npx hardhat test scripts/gas-report.js`)

| Operasi | Gas |
|---|---|
| Launch mode C (tanpa alokasi, tanpa dev buy) | 2.482.433 |
| Launch mode A (2 alokasi vesting + dev buy 10%) | 2.919.605 |
| Swap beli exact-input di jendela anti-sniper | 159.472 |
| Swap beli exact-input setelah jendela | 111.943 |
| `collect` (15 band) | 519.362 |
| `claimCreator` | 43.778 |

Fee Elysium murah (target 300 Mgas/s, fee dalam HYPE), jadi biaya launch ±2,5 juta gas tidak menjadi hambatan.

## 6. Untuk auditor eksternal

1. Akuntansi delta v4 di `CurveHook.beforeSwap`/`afterSwap` (mint ERC-6909 + *return delta*), terutama tanda dan
   pembulatan.
2. Rumus surcharge exact-input/exact-output dan interaksinya dengan fee LP override.
3. Urutan di `seed` (initialize → `updateDynamicLPFee` → unlock: band, settle, dev buy, take) dan refund.
4. `LaunchCore.hashParams` (abi.encode struct dengan array dinamis) sebagai pengikat tanda tangan mode B.
5. Validasi preset dan batas likuiditas per tick di kedua urutan token.
