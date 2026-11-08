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

Status (5 Nov 2026): desain revisi 2 disetujui; **fase 1–6 selesai**. Eridanos v2 + Provenalt ter-deploy di Elysium
testnet 99801 dan lulus uji asap 33/33 (alamat di `05-runbook-testnet.md`). Admin testnet dipindah ke dompet pemilik proyek
`0x78DceE56aD39180adDed458B8D09D445aAbFAde1`; source terverifikasi di explorer (Sourcify Conduit).

Kode: `contracts/v2/` (protokol Eridanos), `contracts/v2/app/` (Provenalt), `sdk/`, `examples/`, `frontend/`,
test di `test/v2/`.

Nama app: **Provenalt** (sejak 8 Nov 2026; sebelumnya Hypelys). Kontrak router yang sudah ter-deploy tetap bernama
`HypelysRouter` karena source-nya sudah terverifikasi; yang terlihat pengguna (frontend, profil integrator #1) memakai
nama Provenalt.
