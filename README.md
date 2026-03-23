# PodHero

**Weekly podcast intelligence. Stay informed without the backlog.**

PodHero is a personalized podcast digest product that automatically scans the podcasts you follow, summarizes new episodes with AI, and delivers a polished weekly briefing to your inbox — so you get the signal without sitting through hours of audio.

---

## What it does

Users sign up, select their interests and favorite shows, and receive a curated weekly email every Monday. Each digest includes AI-generated episode summaries, key takeaways, notable quotes, and links to listen.

The full pipeline runs automatically:
1. RSS feeds are ingested from tracked podcasts
2. New episodes published in the last 7 days are identified
3. Claude summarizes each episode into concise, readable briefings
4. Episodes are scored for relevance against each user's interests
5. A personalized digest email is assembled and sent via Resend

---

## Tech stack

| Layer | Tool |
|---|---|
| Frontend | React (single HTML file, no build step) |
| API | Node.js + Express |
| Database | Supabase (Postgres) |
| AI | Claude (Anthropic) — episode summarization |
| RSS ingestion | fast-xml-parser |
| Email delivery | Resend |
| Scheduler | node-cron (Monday 7am) |
| Hosting | Render |

---

## Architecture

```
User signs up (frontend)
        │
        ▼
POST /api/subscribe
  → Saves to Supabase: users + user_preferences
        │
        │  (Monday 7am via node-cron)
        ▼
worker.js
  1. Fetch active users + preferences
  2. Ingest RSS feeds from podcast_sources table
  3. Upsert new episodes → Supabase
  4. Summarize each episode with Claude → Supabase
  5. Score episodes per user (interest + podcast overlap)
  6. Generate editorial intro with Claude
  7. Send digest email via Resend
  8. Save digest record → Supabase
```

---

## API endpoints

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/subscribe` | Create user + save preferences |
| GET | `/api/user/:email` | Fetch user + preferences |
| PUT | `/api/preferences` | Update interests/podcasts |
| POST | `/api/digests/preview` | Generate digest preview (no email) |
| GET | `/api/digests/:userId` | List past digests |
| POST | `/api/digests/send-now` | Trigger immediate digest send |

---

## Database schema

7 tables: `users`, `user_preferences`, `podcast_sources`, `episodes`, `summaries`, `digests`, `user_subscriptions`. Full schema in `schema.sql`.

Row-level security enabled on user-facing tables. Backend uses the Supabase service role key to bypass RLS for the digest worker.

---

## Setup

### Prerequisites
- Node.js 18+
- Supabase account (free)
- Anthropic API key
- Resend account (free — 3,000 emails/month)
- Podcast Index API key (free)

### 1. Clone and install
```bash
git clone https://github.com/yourname/podhero-backend
cd podhero-backend
npm install
```

### 2. Environment variables
```bash
cp .env.example .env
# Fill in your keys
```

### 3. Database
Run `schema.sql` in the Supabase SQL editor to create all tables. Then seed `podcast_sources` with RSS feed URLs (see README for INSERT block).

### 4. Run locally
```bash
npm run dev           # Start API server
node worker.js --run-now  # Trigger digest pipeline immediately
```

### 5. Deploy
Push to GitHub → connect to Render → add environment variables → deploy. The cron job runs automatically inside the same process.

---

## Project structure

```
podhero-backend/
├── server.js       — Express API
├── worker.js       — RSS ingestion, Claude summarization, email delivery
├── schema.sql      — Supabase Postgres schema
├── package.json
├── .env.example
└── README.md
```

---

## Built by

Simas Zavistauskas — Associate Product Manager at JPMorgan Chase, building PodHero as a side project to explore AI-powered content intelligence products.

[LinkedIn]([https://linkedin.com/in/simaszavistauskas](https://www.linkedin.com/in/simas-zavistauskas-a1a045192/))
