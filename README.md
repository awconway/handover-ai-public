# Handover AI

Handover AI is a web application for recording, reviewing and sharing clinical handovers. It combines local speech transcription with AI-assisted summaries, checklists and task tracking. Implements features from [AI-Based Structured Information Extraction From Synthetic Nursing Handover Transcripts: Comparative Evaluation of Large Language Models](https://nursing.jmir.org/2026/1/e106133/) and accompanying co-design study (not yet published).

Funded by The Prince Charles Hospital Foundation Collaboration Grant.

## Local setup

Requires Node.js 24.3+, pnpm 11.6.0, Python 3.12, uv, Docker Compose (or PostgreSQL 16), ffmpeg and heif-convert.

The commands below run the application and Python services natively on Apple Silicon, with PostgreSQL in Docker.

```sh
pnpm install --frozen-lockfile
uv sync --project apps/worker --frozen
uv sync --project apps/local-privacy --frozen --extra mlx --extra test
cp .env.example .env
cp .env.local-privacy.example .env.local-privacy
```

Set `OPENAI_API_KEY` and replace the session, worker and local privacy secret placeholders. Use the same `LOCAL_PRIVACY_SHARED_SECRET` in both environment files.

Start the local database:

```sh
docker compose up -d --wait postgres
```

The example `DATABASE_URL` matches this database on `127.0.0.1:5433`. If you change `POSTGRES_PASSWORD` or `POSTGRES_PORT`, update `DATABASE_URL` to match. To use your own PostgreSQL 16 instance, skip Docker and set `DATABASE_URL` to an empty database.

Download the models used by the local transcription and de-identification service:

```sh
uv run --project apps/local-privacy --no-sync hf download omi-health/omi-med-stt-v1-mlx-q8
uv run --project apps/local-privacy --no-sync hf download OpenMed/OpenMed-PII-SuperClinical-Large-434M-v1 --revision df7af994d39d358e52f929ff1b3a40d894adf022
uv run --project apps/local-privacy --no-sync hf download OpenMed/OpenMed-PII-SuperClinical-Large-434M-v1-mlx --revision 007fbe157b29d8088c64ffe2c43d00879c18113a
```

```sh
pnpm migrate
pnpm dev
```

Open `http://localhost:8787`. Transcription runs locally; AI summaries and DSPy analysis require access to the OpenAI API.

Stop the application with Ctrl+C. Stop PostgreSQL with `docker compose down`; its data remains in the local Docker volume.

## Checks

```sh
pnpm build
pnpm --filter @handover/remix exec playwright install chromium
pnpm test
uv run --project apps/local-privacy --no-sync python -m unittest discover -s apps/local-privacy/tests -v
```

## Licence

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md).
