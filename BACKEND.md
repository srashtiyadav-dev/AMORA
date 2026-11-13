# Kindred backend

Kindred includes a Node.js API, PostgreSQL schema, phone-number and password accounts, persisted profiles/likes/matches/messages, a six-question Digital Chemistry Test, generated Personality Twin summaries, and mutual-comfort compatibility scoring. Passwords are hashed with Node's scrypt implementation. Phone numbers are used as account IDs but are not SMS-verified. Compatibility currently uses transparent answer-alignment scoring; it is not a trained machine-learning model.

## Local setup

1. Install Node.js 20+ and PostgreSQL 14+.
2. Create a database named `kindred`.
3. Copy `.env.example` to `.env` and fill in `DATABASE_URL` and a random `JWT_SECRET` with at least 32 characters.
4. Run `npm install`, then `npm start`.
5. Open `http://localhost:3000`.

The service creates the tables in `server/schema.sql` at startup. Keep `.env` private. The app serves its static files and API from the same origin, so a separate CORS origin is not needed in the default setup. The sign-in, profile, discovery, match, and chat screens use the API when served by this Node server; opening the files through a static file server keeps the local demo mode.

## Render setup

The included `render.yaml` defines one Node web service. Create a PostgreSQL database in Render, then provide its internal connection string as `DATABASE_URL`. Render generates `JWT_SECRET`. The service binds to Render's `PORT` and serves both the site and API. Render's free Postgres database expires after 30 days, so use a persistent database plan before storing data you need to keep. The free web service can also spin down while idle.

## API

All protected endpoints require `Authorization: Bearer <token>`. Phone numbers use E.164 format.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Health check |
| `POST` | `/api/auth/password` | Create an account or sign in: `{ "phone": "+14155552671", "password": "...", "mode": "register" }` or `"login"` |
| `GET` | `/api/chemistry` | Get the signed-in user's chemistry answers and Personality Twin |
| `PUT` | `/api/chemistry` | Save the six Chemistry Test answers and generate a Personality Twin |
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

Browser voice/video calls now use WebRTC media with Socket.IO signaling. The app includes a public STUN server by default. For networks that cannot connect directly, configure `RTC_ICE_SERVERS` as a JSON array of TURN server objects in the Render service environment; use provider-issued short-lived credentials where available because ICE settings are sent to browsers. Profile pictures can be uploaded from the profile page; the client center-crops and compresses them to JPEG and the server stores up to 800 KB per profile in PostgreSQL.

## Current limits

- This backend enforces the dating app's 18+ minimum from date of birth, but a self-entered birth date is not government-ID age verification.
- The earlier selfie screen is a local demo, not identity/face verification. A verification vendor and server-side integration are still required before showing a verified badge.
- Voice/video calls use browser WebRTC and require microphone/camera permission. Direct STUN connections work on many networks; a TURN relay is still needed for some restrictive networks.
- Uploaded profile pictures use PostgreSQL storage, so keep image sizes small and monitor the database storage limit.
- The demo selfie step is not wired to an identity provider and must not be used as a verified badge.
