# Desain: protokol peluncuran dua lapis di Elysium

Arsitektur dua lapis seperti Bankr di atas Doppler: **lapis protokol** terbuka untuk banyak app, dan **lapis app**
dengan launchpad kita sebagai integrator pertama. Mesin pool mengikuti model Ascend.

| Dokumen | Isi |
|---|---|
| [01-riset-model-acuan.md](01-riset-model-acuan.md) | Doppler, Bankr, Ascend, dan perbandingan PoolManager, dibaca dari sumber asli dengan rujukan baris |
| [02-desain-arsitektur.md](02-desain-arsitektur.md) | Desain: identitas integrator, kebijakan supply, mesin pool, bagi hasil, lapis app, alur launch, daftar kontrak, keamanan |
| [03-rencana-kerja.md](03-rencana-kerja.md) | Fase kerja dengan kriteria selesai, status, dan keputusan |
| [04-review-fase4.md](04-review-fase4.md) | Review internal: skenario serangan, temuan, checklist keamanan, gas |
| [05-runbook-testnet.md](05-runbook-testnet.md) | Langkah deploy testnet (fase 6) untuk pemilik proyek |

Status (4 Nov 2026): desain revisi 2 disetujui; **fase 1–5 selesai** (kontrak, test, review, router, SDK, frontend).
Fase 6 (deploy testnet 99801) menunggu pemilik proyek: butuh kuncinya sendiri dan akses RPC testnet.

Kode: `contracts/v2/` (protokol Eridanos), `contracts/v2/app/` (Hypelys), `sdk/`, `examples/`, `frontend/`,
test di `test/v2/`.
