# Desain: protokol peluncuran dua lapis di Elysium

Arsitektur dua lapis seperti Bankr di atas Doppler: **lapis protokol** terbuka untuk banyak app, dan **lapis app**
dengan launchpad kita sebagai integrator pertama. Mesin pool mengikuti model Ascend.

| Dokumen | Isi |
|---|---|
| [01-riset-model-acuan.md](01-riset-model-acuan.md) | Doppler, Bankr, Ascend, dan perbandingan PoolManager, dibaca dari sumber asli dengan rujukan baris |
| [02-desain-arsitektur.md](02-desain-arsitektur.md) | Desain: identitas integrator, kebijakan supply, mesin pool, bagi hasil, lapis app, alur launch, daftar kontrak, keamanan |
| [03-rencana-kerja.md](03-rencana-kerja.md) | Fase kerja dengan kriteria selesai, status, dan keputusan |
| [04-review-fase4.md](04-review-fase4.md) | Review internal: skenario serangan, temuan, checklist keamanan, gas (versi Uniswap v4) |
| [05-runbook-testnet.md](05-runbook-testnet.md) | Langkah deploy testnet (fase 6) untuk pemilik proyek |
| [06-runbook-mainnet.md](06-runbook-mainnet.md) | Langkah deploy mainnet (99901) dari Mac pemilik proyek; skrip siap, belum dijalankan |

Status (9 Nov 2026): desain revisi 2 disetujui; **fase 1–6 selesai**; mesin pool diganti dari Uniswap v4 (BUSL-1.1) ke
**PancakeSwap Infinity CL** (GPL-2.0-or-later) dan testnet di-deploy ulang (fase 6b, `02 §5.1`). Eridanos v2 + Provenalt ter-deploy di Elysium
testnet 99801 dan lulus uji asap 33/33 (HYPE) dan 15/15 (USDC) (alamat di `05-runbook-testnet.md`). Admin testnet dipindah ke dompet pemilik proyek
`0x78DceE56aD39180adDed458B8D09D445aAbFAde1`; source terverifikasi di explorer (Sourcify Conduit).

Kode: `contracts/v2/` (protokol Eridanos), `contracts/v2/app/` (Provenalt), `sdk/`, `examples/`, `frontend/`,
`indexer/` (indexer + API untuk Railway), test di `test/v2/`.

Nama app: **Provenalt** (sejak 8 Nov 2026; sebelumnya Hypelys). Sejak deploy ulang 9 Nov 2026 kontrak routernya
bernama `ProvenaltRouter` (deployment lama: `HypelysRouter`).
