require('dotenv').config();

const amqp = require('amqplib');
const cors = require('cors');
const express = require('express');
const jwt = require('jsonwebtoken');
const Minio = require('minio');
const multer = require('multer');
const { createClient } = require('redis');
const crypto = require('crypto');

const pool = require('./db/pool');
const createMessagesRouter = require('./routes/messages');
const createRoomsRouter = require('./routes/rooms');

const app = express();
const port = Number(process.env.PORT || 3002);
const serviceName = process.env.SERVICE_NAME || 'message';
const exchangeName = 'chat.messages';
const maxFileSize = 10 * 1024 * 1024;
const allowedMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'application/zip',
]);

let rabbitConnection;
let rabbitChannel;
let redisClient;

const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT || 'minio',
  port: Number(process.env.MINIO_PORT || 9000),
  useSSL: false,
  accessKey: process.env.MINIO_ROOT_USER,
  secretKey: process.env.MINIO_ROOT_PASSWORD,
});

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(message) {
  console.log(`[${timestamp()}] [${serviceName}] ${message}`);
}

function issueUnauthorized(res) {
  return res.status(401).json({ message: 'Not authorized' });
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return issueUnauthorized(res);
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = {
      id: payload.sub,
      username: payload.username,
      avatarColor: payload.avatarColor,
    };
    return next();
  } catch (_error) {
    return issueUnauthorized(res);
  }
}

async function connectRabbit() {
  rabbitConnection = await amqp.connect(process.env.RABBITMQ_URL);
  rabbitChannel = await rabbitConnection.createChannel();
  await rabbitChannel.assertExchange(exchangeName, 'topic', { durable: true });
}

async function connectRedis() {
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (error) => log(`Redis error: ${error.message}`));
  await redisClient.connect();
}

async function ensureBucket() {
  const bucket = process.env.MINIO_BUCKET;
  const exists = await minioClient.bucketExists(bucket);

  if (!exists) {
    await minioClient.makeBucket(bucket);
  }

  const policy = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: ['*'] },
        Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${bucket}/*`],
      },
    ],
  };

  await minioClient.setBucketPolicy(bucket, JSON.stringify(policy));
}

async function publishMessage(message) {
  if (!rabbitChannel) {
    throw new Error('RabbitMQ channel is not available');
  }

  const routingKey = `room.${message.roomId}`;
  rabbitChannel.publish(exchangeName, routingKey, Buffer.from(JSON.stringify(message)), {
    contentType: 'application/json',
    persistent: true,
  });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxFileSize },
  fileFilter: (_req, file, callback) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      return callback(new Error('Invalid file type'));
    }

    return callback(null, true);
  },
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use((req, _res, next) => {
  log(`${req.method} ${req.originalUrl}`);
  next();
});

app.get('/health', async (_req, res) => {
  const services = {
    db: 'down',
    redis: 'down',
    rabbitmq: rabbitChannel ? 'ok' : 'down',
  };

  try {
    await pool.query('SELECT 1');
    services.db = 'ok';
  } catch (error) {
    log(`DB health error: ${error.message}`);
  }

  try {
    if (redisClient) {
      await redisClient.ping();
      services.redis = 'ok';
    }
  } catch (error) {
    log(`Redis health error: ${error.message}`);
  }

  if (services.db === 'ok' && services.redis === 'ok' && services.rabbitmq === 'ok') {
    return res.json({ status: 'ok', services });
  }

  return res.status(503).json({ status: 'error', services });
});

app.use('/api', authenticate);
app.use('/api/rooms', createRoomsRouter({ pool, log }));
app.use('/api/messages', createMessagesRouter({ pool, publishMessage, log }));

app.get('/api/users/search', async (req, res) => {
  const query = String(req.query.q || '').trim().toLowerCase();

  if (!query) {
    return res.json([]);
  }

  try {
    const { rows } = await pool.query(
      `
        SELECT id, username, avatar_color AS "avatarColor"
        FROM users
        WHERE username ILIKE $1
          AND id <> $2
        ORDER BY username
        LIMIT 20
      `,
      [`%${query}%`, req.user.id]
    );

    return res.json(rows);
  } catch (error) {
    log(`User search error: ${error.message}`);
    return res.status(500).json({ message: 'Unable to search users' });
  }
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'File is required' });
  }

  try {
    const extension = req.file.originalname.includes('.')
      ? `.${req.file.originalname.split('.').pop().toLowerCase()}`
      : '';
    const objectName = `${crypto.randomUUID()}${extension}`;

    await minioClient.putObject(
      process.env.MINIO_BUCKET,
      objectName,
      req.file.buffer,
      req.file.size,
      {
        'Content-Type': req.file.mimetype,
      }
    );

    return res.status(201).json({
      url: `${process.env.APP_BASE_URL || 'http://localhost'}:9000/${process.env.MINIO_BUCKET}/${objectName}`,
    });
  } catch (error) {
    log(`Upload error: ${error.message}`);
    return res.status(500).json({ message: 'Unable to upload file' });
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ message: 'File exceeds 10MB limit' });
  }

  if (error.message === 'Invalid file type') {
    return res.status(400).json({ message: 'Invalid MIME type' });
  }

  log(`Unexpected error: ${error.message}`);
  return res.status(500).json({ message: 'Internal server error' });
});

async function start() {
  await connectRedis();
  await connectRabbit();
  await ensureBucket();

  app.listen(port, () => {
    log(`Message service listening on port ${port}`);
  });
}

start().catch((error) => {
  log(`Startup failure: ${error.message}`);
  process.exit(1);
});
