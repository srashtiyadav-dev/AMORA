# Kindred backend

Kindred now includes a Node.js API, PostgreSQL schema, SMS one-time-code authentication through Twilio Verify, persisted profiles/likes/matches/messages, and authenticated Socket.IO channels for chat and WebRTC signaling.

## Local setup

1. Install Node.js 20+ and PostgreSQL 14+.
2. Create a database named `kindred`.
3. Copy `.env.example` to `.env` and fill in `DATABASE_URL`, a random `JWT_SECRET` with at least 32 characters, and Twilio Verify credentials.
4. Run `npm install`, then `npm start`.
5. Open `http://localhost:3000`.

The service creates the tables in `server/schema.sql` at startup. Keep `.env` private. The app serves its static files and API from the same origin, so a separate CORS origin is not needed in the default setup. The sign-in, profile, discovery, match, and chat screens use the API when served by this Node server; opening the files through a static file server keeps the local demo mode.

## Render setup

The included `render.yaml` defines one Node web service. Create a PostgreSQL database in Render, then provide its internal connection string as `DATABASE_URL`. Render generates `JWT_SECRET`; add the three Twilio Verify values in the service environment. The service binds to Render's `PORT` and serves both the site and API. Render's free Postgres database expires after 30 days, so use a persistent database plan before storing data you need to keep. The free web service can also spin down while idle.

Twilio Verify sends real SMS messages and may incur charges. Do not enable a fixed/demo OTP in production.

## API

All protected endpoints require `Authorization: Bearer <token>`. Phone numbers use E.164 format.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Health check |
| `POST` | `/api/auth/start` | Send OTP: `{ "phone": "+14155552671" }` |
| `POST` | `/api/auth/verify` | Verify OTP and return session token/profile |
| `GET` | `/api/me` | Get the signed-in user's profile |
| `PUT` | `/api/profile` | Create/update profile; requires date of birth, gender, interests, relationship goal |
| `GET` | `/api/profiles?search=...` | Find mutually compatible adults; optional search/limit |
| `POST` | `/api/likes/:profileId` | Like a profile; creates a match only after a reciprocal like |
| `POST` | `/api/profiles/:profileId/pass` | Pass on a profile |
| `GET` | `/api/matches` | List matches and recent messages |
| `GET` | `/api/matches/:matchId/messages` | Load a match's messages |
| `POST` | `/api/matches/:matchId/messages` | Persist/send a message |
| `POST` | `/api/profiles/:profileId/block` | Block a profile |
| `POST` | `/api/profiles/:profileId/report` | Report a profile |

Socket.IO clients authenticate with `{ auth: { token } }`, then emit `match:join` with a match ID. `match:message` persists and broadcasts a message. `call:signal` relays only `start`, `offer`, `answer`, `ice`, `ready`, and `end` events inside a verified match room.

## Current limits

- This backend enforces the dating app's 18+ minimum from date of birth, but a self-entered birth date is not government-ID age verification.
- The earlier selfie screen is a local demo, not identity/face verification. A verification vendor and server-side integration are still required before showing a verified badge.
- A real call needs client-side WebRTC capture and peer negotiation; this backend provides authorized signaling only. TURN service configuration may be needed for some networks.
- Profile photo upload/storage is not implemented yet; `photoUrl` accepts only the current approved Unsplash image host.
- The voice/video buttons still show the earlier demo modal. The backend provides authorized WebRTC signaling, but the browser-side media capture and peer negotiation still need to be implemented. For networks that block direct peer connections, configure a TURN service in the client.
- The demo selfie step is not wired to an identity provider and must not be used as a verified badge.
