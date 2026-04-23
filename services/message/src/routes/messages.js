const express = require('express');

module.exports = function createMessagesRouter({ pool, publishMessage, log }) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    const roomId = String(req.body.roomId || '').trim();
    const content = req.body.content ? String(req.body.content).trim() : '';
    const mediaUrl = req.body.mediaUrl ? String(req.body.mediaUrl).trim() : null;
    const mediaType = req.body.mediaType ? String(req.body.mediaType).trim() : null;

    if (!roomId) {
      return res.status(400).json({ message: 'roomId is required' });
    }

    if (!content && !mediaUrl) {
      return res.status(400).json({ message: 'Message content or media is required' });
    }

    if (content.length > 4096) {
      return res.status(400).json({ message: 'Message exceeds 4096 characters' });
    }

    try {
      const membership = await pool.query(
        'SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2',
        [roomId, req.user.id]
      );

      if (!membership.rows[0]) {
        return res.status(404).json({ message: 'Room not found' });
      }

      const inserted = await pool.query(
        `
          INSERT INTO messages (room_id, sender_id, content, media_url, media_type)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING id, room_id AS "roomId", sender_id AS "senderId",
                    content, media_url AS "mediaUrl", media_type AS "mediaType",
                    status, created_at AS "createdAt"
        `,
        [roomId, req.user.id, content || null, mediaUrl, mediaType]
      );

      const message = {
        ...inserted.rows[0],
        senderName: req.user.username,
        senderAvatarColor: req.user.avatarColor,
      };

      await publishMessage(message);
      return res.status(201).json(message);
    } catch (error) {
      log(`Send message error: ${error.message}`);
      return res.status(500).json({ message: 'Unable to send message' });
    }
  });

  router.patch('/:id/status', async (req, res) => {
    const messageId = req.params.id;
    const status = String(req.body.status || '').trim();
    const allowedStatuses = ['delivered', 'read'];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ message: 'Status must be delivered or read' });
    }

    try {
      const { rows } = await pool.query(
        `
          UPDATE messages AS m
          SET status = CASE
            WHEN m.status = 'read' THEN 'read'
            WHEN $2 = 'read' THEN 'read'
            WHEN m.status = 'delivered' THEN 'delivered'
            ELSE 'delivered'
          END
          FROM room_members rm
          WHERE m.id = $1
            AND rm.room_id = m.room_id
            AND rm.user_id = $3
          RETURNING m.id, m.room_id AS "roomId", m.status, m.sender_id AS "senderId"
        `,
        [messageId, status, req.user.id]
      );

      if (!rows[0]) {
        return res.status(404).json({ message: 'Message not found' });
      }

      return res.json(rows[0]);
    } catch (error) {
      log(`Update message status error: ${error.message}`);
      return res.status(500).json({ message: 'Unable to update status' });
    }
  });

  return router;
};
