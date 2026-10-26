# Handover AI

Requires Node.js 24.3+, pnpm 11.6.0, Python 3.12, uv, PostgreSQL 16, ffmpeg and heif-convert.

## Local setup

The commands below use the Apple Silicon runtime.

```sh
pnpm install --frozen-lockfile
uv sync --project apps/worker --frozen
uv sync --project apps/local-privacy --frozen --extra mlx --extra test
cp .env.example .env
cp .env.local-privacy.example .env.local-privacy
```

Create an empty local PostgreSQL database. Set `DATABASE_URL` to that database, set `OPENAI_API_KEY`, and replace the secret placeholders. Use the same `LOCAL_PRIVACY_SHARED_SECRET` in both environment files.

Download the local models before starting in offline mode:

```sh
uv run --project apps/local-privacy --no-sync hf download omi-health/omi-med-stt-v1-mlx-q8
uv run --project apps/local-privacy --no-sync hf download OpenMed/OpenMed-PII-SuperClinical-Large-434M-v1 --revision df7af994d39d358e52f929ff1b3a40d894adf022
uv run --project apps/local-privacy --no-sync hf download OpenMed/OpenMed-PII-SuperClinical-Large-434M-v1-mlx --revision 007fbe157b29d8088c64ffe2c43d00879c18113a
```

```sh
pnpm migrate
pnpm dev
```

Open `http://localhost:8787`.

## Checks

```sh
pnpm build
pnpm --filter @handover/remix exec playwright install chromium
pnpm test
uv run --project apps/local-privacy --no-sync python -m unittest discover -s apps/local-privacy/tests -v
```

## Licence

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md).
