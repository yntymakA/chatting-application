require('dotenv').config();

const cors = require('cors');
const express = require('express');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const createAuthRouter = require('./routes/auth');

const app = express();
const port = Number(process.env.PORT || 3003);
const serviceName = process.env.SERVICE_NAME || 'auth';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(message) {
  console.log(`[${timestamp()}] [${serviceName}] ${message}`);
}

function issueToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      avatarColor: user.avatarColor,
    },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  log(`${req.method} ${req.originalUrl}`);
  next();
});

app.get('/health', async (_req, res) => {
  const services = {
    db: 'down',
    redis: 'n/a',
    rabbitmq: 'n/a',
  };

  try {
    await pool.query('SELECT 1');
    services.db = 'ok';
    return res.json({ status: 'ok', services });
  } catch (error) {
    log(`Health error: ${error.message}`);
    return res.status(503).json({ status: 'error', services });
  }
});

app.use('/api/auth', createAuthRouter({ pool, issueToken, log }));

app.listen(port, () => {
  log(`Auth service listening on port ${port}`);
});
