# Provenalt indexer

Indexer + REST API untuk protokol Eridanos dan launchpad Provenalt di Elysium. Membaca event kontrak, menyimpannya
di Postgres, dan menyajikan data yang tidak bisa didapat cepat langsung dari chain: daftar token yang bisa diurutkan
dan dicari, grafik harga (candle), riwayat trade dengan alamat trader, holder, volume 24 jam, dan fee.

Kontrak tidak perlu diubah: indexer hanya membaca event yang sudah ada. Satu proses Node menjalankan sinkronisasi
dan API sekaligus. Dependensi: `ethers` dan `pg`; tanpa langkah build.

Deployment aktif (testnet): **https://provenalt-indexer-production.up.railway.app** — project Railway `provenalt-indexer`.

## Yang diindeks

| Sumber | Event | Dipakai untuk |
|---|---|---|
| `LaunchCore` | `Launched` | daftar token, pengungkapan alokasi/dev buy, integrator |
| `PoolManager` (v4) | `Initialize`, `Swap` | harga, candle, volume, trade (termasuk dev buy) |
| Router app (`HypelysRouter`) | `Swapped` | alamat trader asli dan jumlah yang dibayar/diterima pengguna |
| `FeeDistributor` | `FeesSplit` | fee terkumpul per token dan pembagiannya |
| `IntegratorRegistry` | `IntegratorRegistered`, `ProfileUpdated`, `PayoutUpdated`, … | nama integrator |
| Setiap token yang diluncurkan | `Transfer` | saldo dan jumlah holder |

Volume dihitung dari jumlah yang masuk ke pool. Di 10 detik pertama surcharge anti-sniper diambil sebelum pool, jadi
yang dibayar pengguna (`userAmountIn`) bisa lebih besar dari volume pool.

## Deploy ke Railway

1. **Proyek.** Di [railway.com](https://railway.com): *New Project → Deploy from GitHub repo* → pilih
   `fdlr28/cpanelwpku`. Railway perlu izin GitHub ke repo itu (diminta saat pertama kali).
2. **Service indexer.** Buka service yang dibuat → *Settings*:
   * *Source → Branch*: branch yang dipakai (sekarang `claude/hopeful-pascal-icu4bu`, atau `main` setelah di-merge);
   * *Source → Root Directory*: `indexer` (wajib; Railway lalu mendeteksi Node dari `package.json` dan menjalankan
     `npm start`);
   * *Deploy → Healthcheck Path*: `/health` (disarankan);
   * *Build → Watch Paths*: `/indexer/**` (disarankan; pola dihitung dari root repo, bukan dari Root Directory),
     supaya commit di luar `indexer/` tidak memicu deploy ulang.

   Tidak ada `railway.json`: fitur *config as code* Railway sudah deprecated, jadi pengaturan dilakukan di dashboard.
3. **Database.** Di kanvas proyek: *+ Create → Database → PostgreSQL*.
4. **Variabel** di service indexer (*Variables*):

   | Variabel | Nilai |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (referensi ke service Postgres; lewat jaringan privat Railway) |
   | `RPC_URL` | opsional. Default RPC publik testnet yang membatasi request; untuk produksi pakai RPC sendiri (mis. Alchemy) |
   | `CORS_ORIGIN` | opsional, mis. `https://provenalt.xyz` (default `*`) |

5. **Domain.** *Settings → Networking → Generate Domain*. Cek `https://<nama>.up.railway.app/health`:
   `"ok": true` dan `indexedBlock` mendekati `headBlock`. Sinkronisasi awal dari blok deploy hanya butuh beberapa detik.
6. **Frontend.** Buat paket website dengan URL indexer, lalu unggah seperti biasa:

   ```bash
   INDEXER_URL=https://<nama>.up.railway.app bash scripts/package-frontend.sh
   ```

   Atau isi `indexerUrl` di `frontend/config.js`. Bila indexer mati, website otomatis kembali membaca chain langsung.

Jalankan **satu replika** saja (*Settings → Deploy → Replicas* = 1, default): dua proses sinkronisasi ke database yang sama tidak merusak data (semua insert
idempoten), tetapi saling berebut kursor.

## Variabel lain

| Variabel | Default | Keterangan |
|---|---|---|
| `PORT` | `8080` | diisi Railway otomatis |
| `DEPLOYMENT_FILE` | `deployment.json` | alamat kontrak; salin ulang dengan `node indexer/scripts/copy-deployment.js` setelah deploy baru |
| `START_BLOCK` | `deployBlock` | blok awal sinkronisasi |
| `CONFIRMATIONS` | `20` | jarak aman dari kepala chain (Elysium ±12 blok/detik, jadi ±2 detik) |
| `POLL_MS` | `2000` | jeda antar putaran sinkronisasi |
| `MAX_STEP` / `MIN_STEP` | `2000000` / `1000` | rentang blok per `eth_getLogs`; dibagi dua otomatis bila RPC menolak |
| `RPC_CONCURRENCY` / `RPC_MIN_INTERVAL_MS` | `3` / `120` | pembatas request ke RPC |
| `DATABASE_SSL` | kosong | `true` untuk Postgres publik dengan TLS terverifikasi; `no-verify` hanya untuk sertifikat self-signed |
| `SYNC` / `API` | `true` | `false` untuk mematikan salah satunya |
| `PUBLIC_URL` | dari header `Host` | URL publik indexer, untuk URL gambar (Railway: `https://<nama>.up.railway.app`) |
| `UPLOAD_ORIGINS` | kosong (semua) | daftar origin website yang boleh upload, dipisah koma |
| `UPLOADS` | `true` | `false` mematikan upload |
| `MAX_UPLOAD_BYTES` / `UPLOADS_PER_HOUR` / `MAX_IMAGE_STORAGE_BYTES` | `1000000` / `30` / `1000000000` | batas upload |

Database dikunci ke satu chain dan satu `LaunchCore` (tabel `meta`). Untuk deployment kontrak baru, pakai database baru.

## API

Semua `GET`, JSON, CORS. Jumlah berupa string desimal dalam satuan biasa (token 18 desimal, quote sesuai desimalnya).
Harga = quote per token; market cap = harga × 1.000.000.000.

| Endpoint | Isi |
|---|---|
| `/health` | status sinkronisasi (`headBlock`, `indexedBlock`, `lagBlocks`, `lastError`) |
| `/tokens?sort=new\|mcap\|volume\|trades&quote=hype\|usdc\|<alamat>&creator=&integrator=&q=&limit=&offset=` | daftar token + statistik |
| `/tokens/:address` | satu token + fee terkumpul |
| `/tokens/:address/trades?limit=&before=<block>:<logIndex>` | trade terbaru, berhalaman |
| `/tokens/:address/candles?interval=1m\|5m\|15m\|1h\|4h\|1d&limit=` | candle OHLC + volume |
| `/tokens/:address/holders?limit=` | jumlah holder + holder terbesar (kontrak protokol diberi label dan tidak dihitung) |
| `/integrators` | integrator terdaftar |
| `/stats` | total token, trade, trader, volume 24 jam per quote |
| `POST /upload` | gambar token (body mentah PNG/JPEG/WebP/GIF, maks 1 MB) → `{ url, sha256, mime, size }`. Dipakai form peluncuran website |
| `/images/:sha256[.ext]` | gambar yang diunggah (cache permanen, `nosniff`, CSP `sandbox`) |

Upload: format dikenali dari isi file (bukan header), SVG ditolak (bisa berisi script), maks `UPLOADS_PER_HOUR` per IP,
total penyimpanan dibatasi `MAX_IMAGE_STORAGE_BYTES`, dan bila `UPLOAD_ORIGINS` diisi hanya website itu yang boleh
mengunggah. Gambar disimpan di Postgres (tabel `images`) dan alamatnya berbasis hash isi. Konten unggahan pengguna
tidak dimoderasi otomatis.

Urutan `mcap`/`volume` membandingkan angka mentah, jadi hanya bermakna dalam satu quote (pakai `quote=`).

## Lokal

```bash
cd indexer && npm install
DATABASE_URL=postgres://user:pass@localhost:5432/provenalt npm start
```

Uji end-to-end (chain lokal dengan peluncuran dan trading, mis. setelah `scripts/deploy-local-v2.js` dan
`scripts/smoke-testnet-v2.js`): membandingkan database dan API dengan state on-chain (saldo tiap holder, jumlah
swap, arah trade, harga terakhir, idempotensi):

```bash
DATABASE_URL=... RPC_URL=http://127.0.0.1:8545 DEPLOYMENT_FILE=../deployments/localhost-v2.json npm test
```
