require('dotenv').config();

const amqp = require('amqplib');
const express = require('express');
const http = require('http');
const { Pool } = require('pg');
const { createClient } = require('redis');
const { WebSocketServer } = require('ws');

const PresenceManager = require('./presenceManager');
const createSocketHandler = require('./socketHandler');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const port = Number(process.env.PORT || 3001);
const serviceName = process.env.SERVICE_NAME || 'connection';
const exchangeName = 'chat.messages';
const queueName = `ws-delivery-${process.env.INSTANCE_ID || 'instance-1'}`;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let redisClient;
let redisPublisher;
let redisSubscriber;
let rabbitConnection;
let rabbitChannel;

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(message) {
  console.log(`[${timestamp()}] [${serviceName}] ${message}`);
}

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

async function start() {
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisPublisher = createClient({ url: process.env.REDIS_URL });
  redisSubscriber = createClient({ url: process.env.REDIS_URL });

  for (const client of [redisClient, redisPublisher, redisSubscriber]) {
    client.on('error', (error) => log(`Redis error: ${error.message}`));
    await client.connect();
  }

  rabbitConnection = await amqp.connect(process.env.RABBITMQ_URL);
  rabbitChannel = await rabbitConnection.createChannel();
  await rabbitChannel.assertExchange(exchangeName, 'topic', { durable: true });
  await rabbitChannel.assertQueue(queueName, { durable: true });
  await rabbitChannel.bindQueue(queueName, exchangeName, 'room.*');

  const presenceManager = new PresenceManager({
    redis: redisClient,
    publisher: redisPublisher,
    pool,
    log,
  });

  const socketHandler = createSocketHandler({
    pool,
    channel: rabbitChannel,
    exchangeName,
    presenceManager,
    log,
  });

  wss.on('connection', (ws) => {
    socketHandler.attachSocket(ws);
  });

  socketHandler.startHeartbeatMonitor();

  await redisSubscriber.subscribe('presence-channel', async (message) => {
    try {
      socketHandler.broadcastPresence({
        type: 'presence',
        ...JSON.parse(message),
      });
    } catch (error) {
      log(`Presence subscription error: ${error.message}`);
    }
  });

  await rabbitChannel.consume(queueName, async (msg) => {
    if (!msg) {
      return;
    }

    try {
      const payload = JSON.parse(msg.content.toString());
      await socketHandler.handleBrokerMessage(payload);
      rabbitChannel.ack(msg);
    } catch (error) {
      log(`Broker consume error: ${error.message}`);
      rabbitChannel.nack(msg, false, false);
    }
  });

  server.listen(port, () => {
    log(`Connection service listening on port ${port}`);
  });
}

start().catch((error) => {
  log(`Startup failure: ${error.message}`);
  process.exit(1);
});
