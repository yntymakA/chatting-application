const jwt = require('jsonwebtoken');

function createSocketHandler({ pool, channel, exchangeName, presenceManager, log }) {
  const sockets = new Set();
  const userSockets = new Map();

  function send(ws, payload) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(payload));
    }
  }

  function sendError(ws, message) {
    send(ws, { type: 'error', message });
  }

  function addUserSocket(userId, ws) {
    const current = userSockets.get(userId) || new Set();
    current.add(ws);
    userSockets.set(userId, current);
  }

  function removeUserSocket(userId, ws) {
    const current = userSockets.get(userId);

    if (!current) {
      return;
    }

    current.delete(ws);
    if (!current.size) {
      userSockets.delete(userId);
    }
  }

  async function verifyMembership(roomId, userId) {
    const { rows } = await pool.query(
      'SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2',
      [roomId, userId]
    );
    return Boolean(rows[0]);
  }

  async function fetchUserFromToken(token) {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await pool.query(
      `
        SELECT id, username, avatar_color AS "avatarColor"
        FROM users
        WHERE id = $1
      `,
      [payload.sub]
    );

    if (!rows[0]) {
      throw new Error('User not found');
    }

    return {
      tokenPayload: payload,
      user: rows[0],
    };
  }

  async function publishMessage(message) {
    channel.publish(
      exchangeName,
      `room.${message.roomId}`,
      Buffer.from(JSON.stringify(message)),
      {
        contentType: 'application/json',
        persistent: true,
      }
    );
  }

  async function createMessage({ roomId, content, mediaUrl, mediaType }, user) {
    const inserted = await pool.query(
      `
        INSERT INTO messages (room_id, sender_id, content, media_url, media_type)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, room_id AS "roomId", sender_id AS "senderId", content,
                  media_url AS "mediaUrl", media_type AS "mediaType",
                  status, created_at AS "createdAt"
      `,
      [roomId, user.id, content || null, mediaUrl || null, mediaType || null]
    );

    const message = {
      ...inserted.rows[0],
      senderName: user.username,
      senderAvatarColor: user.avatarColor,
    };

    await publishMessage(message);
    return message;
  }

  async function broadcastToRoomMembers(roomId, payload) {
    const members = await pool.query(
      'SELECT user_id AS "userId" FROM room_members WHERE room_id = $1',
      [roomId]
    );

    for (const member of members.rows) {
      const memberSockets = userSockets.get(member.userId);
      if (!memberSockets) {
        continue;
      }

      for (const ws of memberSockets) {
        send(ws, payload);
      }
    }
  }

  async function markDelivered(message) {
    const delivered = await pool.query(
      `
        UPDATE messages
        SET status = CASE
          WHEN status = 'read' THEN 'read'
          ELSE 'delivered'
        END
        WHERE id = $1
        RETURNING id, room_id AS "roomId", status, sender_id AS "senderId"
      `,
      [message.id]
    );

    if (delivered.rows[0]) {
      await broadcastToRoomMembers(message.roomId, {
        type: 'read',
        roomId: delivered.rows[0].roomId,
        userId: delivered.rows[0].senderId,
        messageId: delivered.rows[0].id,
        status: delivered.rows[0].status,
      });
    }
  }

  async function handleBrokerMessage(payload) {
    const members = await pool.query(
      'SELECT user_id AS "userId" FROM room_members WHERE room_id = $1',
      [payload.roomId]
    );

    let deliveredToRecipient = false;

    for (const member of members.rows) {
      const memberSockets = userSockets.get(member.userId);
      if (!memberSockets) {
        continue;
      }

      if (member.userId !== payload.senderId && memberSockets.size) {
        deliveredToRecipient = true;
      }

      for (const ws of memberSockets) {
        send(ws, {
          type: 'message',
          id: payload.id,
          roomId: payload.roomId,
          senderId: payload.senderId,
          senderName: payload.senderName,
          senderAvatarColor: payload.senderAvatarColor,
          content: payload.content,
          mediaUrl: payload.mediaUrl,
          mediaType: payload.mediaType,
          status: payload.status,
          createdAt: payload.createdAt,
        });
      }
    }

    if (deliveredToRecipient) {
      await markDelivered(payload);
    }
  }

  async function handleRead(ws, data) {
    const roomId = String(data.roomId || '').trim();
    const messageId = String(data.messageId || '').trim();

    if (!roomId || !messageId) {
      return sendError(ws, 'roomId and messageId are required');
    }

    if (!(await verifyMembership(roomId, ws.user.id))) {
      return sendError(ws, 'Room not found');
    }

    const updated = await pool.query(
      `
        UPDATE messages AS m
        SET status = 'read'
        FROM room_members rm
        WHERE m.id = $1
          AND m.room_id = $2
          AND rm.room_id = m.room_id
          AND rm.user_id = $3
        RETURNING m.id
      `,
      [messageId, roomId, ws.user.id]
    );

    if (!updated.rows[0]) {
      return sendError(ws, 'Message not found');
    }

    await broadcastToRoomMembers(roomId, {
      type: 'read',
      roomId,
      userId: ws.user.id,
      messageId,
      status: 'read',
    });
  }

  async function handleTyping(ws, data) {
    const roomId = String(data.roomId || '').trim();
    const isTyping = Boolean(data.isTyping);

    if (!roomId) {
      return sendError(ws, 'roomId is required');
    }

    if (!(await verifyMembership(roomId, ws.user.id))) {
      return sendError(ws, 'Room not found');
    }

    await presenceManager.setTyping(roomId, ws.user.id, isTyping);
    await broadcastToRoomMembers(roomId, {
      type: 'typing',
      roomId,
      userId: ws.user.id,
      username: ws.user.username,
      isTyping,
    });
  }

  async function handleJoin(ws, data) {
    const roomId = String(data.roomId || '').trim();

    if (!roomId) {
      return sendError(ws, 'roomId is required');
    }

    if (!(await verifyMembership(roomId, ws.user.id))) {
      return sendError(ws, 'Room not found');
    }

    ws.joinedRooms.add(roomId);
  }

  async function handleSocketMessage(ws, raw) {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (_error) {
      return sendError(ws, 'Invalid JSON payload');
    }

    if (data.type === 'auth') {
      if (!data.token) {
        return sendError(ws, 'Not authorized');
      }

      try {
        const { user } = await fetchUserFromToken(data.token);
        ws.authToken = data.token;
        ws.user = user;
        ws.lastHeartbeatAt = Date.now();
        addUserSocket(user.id, ws);
        await presenceManager.setOnline(user);
        const onlineUsers = await presenceManager.listOnlineUsers();
        for (const onlineUser of onlineUsers) {
          send(ws, {
            type: 'presence',
            userId: onlineUser.userId,
            username: onlineUser.username,
            status: onlineUser.status,
          });
        }
        log(`User ${user.username} connected`);
      } catch (_error) {
        return sendError(ws, 'Not authorized');
      }

      return;
    }

    if (!ws.authToken) {
      return sendError(ws, 'Not authorized');
    }

    try {
      await fetchUserFromToken(ws.authToken);
    } catch (_error) {
      return sendError(ws, 'Not authorized');
    }

    if (data.type === 'ping') {
      ws.lastHeartbeatAt = Date.now();
      await presenceManager.refresh(ws.user);
      return;
    }

    if (data.type === 'join') {
      return handleJoin(ws, data);
    }

    if (data.type === 'typing') {
      return handleTyping(ws, data);
    }

    if (data.type === 'read') {
      return handleRead(ws, data);
    }

    if (data.type === 'message') {
      const roomId = String(data.roomId || '').trim();
      const content = data.content ? String(data.content).trim() : '';

      if (!roomId) {
        return sendError(ws, 'roomId is required');
      }

      if (!content) {
        return sendError(ws, 'Message content is required');
      }

      if (content.length > 4096) {
        return sendError(ws, 'Message exceeds 4096 characters');
      }

      if (!(await verifyMembership(roomId, ws.user.id))) {
        return sendError(ws, 'Room not found');
      }

      await createMessage({ roomId, content }, ws.user);
      return;
    }

    return sendError(ws, 'Unsupported event type');
  }

  function attachSocket(ws) {
    ws.joinedRooms = new Set();
    ws.lastHeartbeatAt = Date.now();
    sockets.add(ws);

    ws.on('message', async (raw) => {
      try {
        await handleSocketMessage(ws, raw);
      } catch (error) {
        log(`Socket message error: ${error.message}`);
        sendError(ws, 'Internal server error');
      }
    });

    ws.on('close', async () => {
      sockets.delete(ws);

      if (ws.user) {
        removeUserSocket(ws.user.id, ws);
        const stillConnected = userSockets.get(ws.user.id);

        if (!stillConnected || !stillConnected.size) {
          try {
            await presenceManager.setOffline(ws.user);
            log(`User ${ws.user.username} disconnected`);
          } catch (error) {
            log(`Disconnect cleanup error: ${error.message}`);
          }
        }
      }
    });
  }

  function broadcastPresence(payload) {
    for (const ws of sockets) {
      if (ws.user) {
        send(ws, payload);
      }
    }
  }

  function startHeartbeatMonitor() {
    setInterval(() => {
      const cutoff = Date.now() - 30000;

      for (const ws of sockets) {
        if (ws.user && ws.lastHeartbeatAt < cutoff) {
          sendError(ws, 'Connection heartbeat expired');
          ws.terminate();
        }
      }
    }, 5000);
  }

  return {
    attachSocket,
    broadcastPresence,
    handleBrokerMessage,
    startHeartbeatMonitor,
  };
}

module.exports = createSocketHandler;
