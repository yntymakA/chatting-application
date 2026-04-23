const express = require('express');
const bcrypt = require('bcryptjs');

function createAvatarColor(username) {
  const palette = ['#0088cc', '#3cb371', '#ff8c42', '#f94144', '#f9c74f', '#577590'];
  const total = username.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return palette[total % palette.length];
}

module.exports = function createAuthRouter({ pool, issueToken, log }) {
  const router = express.Router();

  router.post('/register', async (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!username || username.length < 3) {
      return res.status(400).json({ message: 'Username must be at least 3 characters long' });
    }

    if (!password || password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters long' });
    }

    try {
      const passwordHash = await bcrypt.hash(password, 10);
      const avatarColor = createAvatarColor(username);
      const { rows } = await pool.query(
        `
          INSERT INTO users (username, password_hash, avatar_color)
          VALUES ($1, $2, $3)
          RETURNING id, username, avatar_color AS "avatarColor", created_at AS "createdAt"
        `,
        [username, passwordHash, avatarColor]
      );

      const user = rows[0];
      log(`Registered user ${user.username}`);
      return res.status(201).json({ token: issueToken(user), user });
    } catch (error) {
      if (error.code === '23505') {
        return res.status(409).json({ message: 'Username already exists' });
      }

      log(`Register error: ${error.message}`);
      return res.status(500).json({ message: 'Unable to register user' });
    }
  });

  router.post('/login', async (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password are required' });
    }

    try {
      const { rows } = await pool.query(
        `
          SELECT id, username, password_hash, avatar_color AS "avatarColor", created_at AS "createdAt"
          FROM users
          WHERE username = $1
        `,
        [username]
      );

      if (!rows[0]) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      const user = rows[0];
      const isValid = await bcrypt.compare(password, user.password_hash);

      if (!isValid) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      delete user.password_hash;
      log(`User ${user.username} logged in`);
      return res.json({ token: issueToken(user), user });
    } catch (error) {
      log(`Login error: ${error.message}`);
      return res.status(500).json({ message: 'Unable to login' });
    }
  });

  return router;
};
