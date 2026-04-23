CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_color VARCHAR(7) DEFAULT '#5865F2',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100),
  type VARCHAR(10) NOT NULL CHECK (type IN ('direct', 'group')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES users(id),
  content TEXT,
  media_url TEXT,
  media_type VARCHAR(20),
  status VARCHAR(10) DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'read')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id);

INSERT INTO users (username, password_hash, avatar_color)
SELECT seed.username, crypt('password123', gen_salt('bf')), seed.avatar_color
FROM (
  VALUES
    ('alice', '#0088cc'),
    ('bob', '#3cb371'),
    ('charlie', '#ff8c42')
) AS seed(username, avatar_color)
ON CONFLICT (username) DO NOTHING;

INSERT INTO rooms (name, type)
SELECT 'General', 'group'
WHERE NOT EXISTS (
  SELECT 1 FROM rooms WHERE name = 'General' AND type = 'group'
);

INSERT INTO room_members (room_id, user_id)
SELECT general.id, users.id
FROM rooms AS general
CROSS JOIN users
WHERE general.name = 'General'
  AND general.type = 'group'
ON CONFLICT (room_id, user_id) DO NOTHING;
