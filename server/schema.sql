CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 text NOT NULL UNIQUE,
  password_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;

CREATE TABLE IF NOT EXISTS profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 40),
  birth_date date NOT NULL CHECK (birth_date <= (current_date - interval '18 years')::date),
  gender text NOT NULL CHECK (char_length(gender) BETWEEN 1 AND 40),
  interested_in text[] NOT NULL DEFAULT '{}',
  relationship_goal text NOT NULL CHECK (char_length(relationship_goal) BETWEEN 1 AND 80),
  city text NOT NULL DEFAULT '' CHECK (char_length(city) <= 100),
  bio text NOT NULL DEFAULT '' CHECK (char_length(bio) <= 500),
  interests text[] NOT NULL DEFAULT '{}',
  photo_url text NOT NULL DEFAULT '' CHECK (char_length(photo_url) <= 2048),
  chemistry_answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  personality_twin text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS chemistry_answers jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS personality_twin text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS likes (
  from_user uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_user, to_user),
  CHECK (from_user <> to_user)
);

CREATE TABLE IF NOT EXISTS passes (
  from_user uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_user, to_user),
  CHECK (from_user <> to_user)
);

CREATE TABLE IF NOT EXISTS matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_a < user_b),
  UNIQUE (user_a, user_b)
);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX IF NOT EXISTS messages_match_created_idx ON messages (match_id, created_at DESC);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 2 AND 80),
  details text NOT NULL DEFAULT '' CHECK (char_length(details) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reporter_id <> reported_id)
);
CREATE INDEX IF NOT EXISTS reports_created_idx ON reports (created_at DESC);
