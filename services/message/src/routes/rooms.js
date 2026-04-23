const express = require('express');

module.exports = function createRoomsRouter({ pool, log }) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `
          SELECT
            r.id,
            COALESCE(
              CASE
                WHEN r.type = 'direct' THEN (
                  SELECT u.username
                  FROM room_members rm_other
                  JOIN users u ON u.id = rm_other.user_id
                  WHERE rm_other.room_id = r.id
                    AND rm_other.user_id <> $1
                  ORDER BY u.username
                  LIMIT 1
                )
                ELSE r.name
              END,
              r.name,
              'Direct Chat'
            ) AS name,
            r.type,
            lm.id AS last_message_id,
            lm.content AS last_message_content,
            lm.media_url AS last_message_media_url,
            lm.media_type AS last_message_media_type,
            lm.status AS last_message_status,
            lm.created_at AS last_message_created_at,
            lm.sender_name AS last_message_sender_name,
            COALESCE((
              SELECT COUNT(*)
              FROM messages unread
              WHERE unread.room_id = r.id
                AND unread.sender_id <> $1
                AND unread.status <> 'read'
            ), 0)::int AS unread_count
          FROM rooms r
          JOIN room_members membership
            ON membership.room_id = r.id
           AND membership.user_id = $1
          LEFT JOIN LATERAL (
            SELECT
              m.id,
              m.content,
              m.media_url,
              m.media_type,
              m.status,
              m.created_at,
              sender.username AS sender_name
            FROM messages m
            LEFT JOIN users sender ON sender.id = m.sender_id
            WHERE m.room_id = r.id
            ORDER BY m.created_at DESC
            LIMIT 1
          ) lm ON TRUE
          ORDER BY COALESCE(lm.created_at, r.created_at) DESC
        `,
        [req.user.id]
      );

      return res.json(
        rows.map((room) => ({
          id: room.id,
          name: room.name,
          type: room.type,
          unreadCount: room.unread_count,
          lastMessage: room.last_message_id
            ? {
                id: room.last_message_id,
                content: room.last_message_content,
                mediaUrl: room.last_message_media_url,
                mediaType: room.last_message_media_type,
                status: room.last_message_status,
                createdAt: room.last_message_created_at,
                senderName: room.last_message_sender_name,
              }
            : null,
        }))
      );
    } catch (error) {
      log(`List rooms error: ${error.message}`);
      return res.status(500).json({ message: 'Unable to load rooms' });
    }
  });

  router.post('/', async (req, res) => {
    const type = String(req.body.type || '').trim();
    const requestedName = req.body.name ? String(req.body.name).trim() : null;
    const memberIds = Array.isArray(req.body.memberIds) ? req.body.memberIds.filter(Boolean) : [];

    if (!['direct', 'group'].includes(type)) {
      return res.status(400).json({ message: 'Room type must be direct or group' });
    }

    const uniqueMembers = Array.from(new Set([req.user.id, ...memberIds]));

    if (type === 'direct' && uniqueMembers.length !== 2) {
      return res.status(400).json({ message: 'Direct rooms must have exactly two members' });
    }

    if (type === 'group' && (!requestedName || uniqueMembers.length < 2)) {
      return res.status(400).json({ message: 'Group rooms require a name and at least two members' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const validMembers = await client.query(
        'SELECT id FROM users WHERE id = ANY($1::uuid[])',
        [uniqueMembers]
      );

      if (validMembers.rows.length !== uniqueMembers.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'One or more members were not found' });
      }

      if (type === 'direct') {
        const existing = await client.query(
          `
            SELECT r.id
            FROM rooms r
            JOIN room_members rm ON rm.room_id = r.id
            WHERE r.type = 'direct'
              AND rm.user_id = ANY($1::uuid[])
            GROUP BY r.id
            HAVING COUNT(*) = 2
               AND COUNT(*) = (
                 SELECT COUNT(*) FROM room_members where room_id = r.id
               )
            LIMIT 1
          `,
          [uniqueMembers]
        );

        if (existing.rows[0]) {
          await client.query('ROLLBACK');
          return res.json({ id: existing.rows[0].id, type, reused: true });
        }
      }

      const createdRoom = await client.query(
        `
          INSERT INTO rooms (name, type)
          VALUES ($1, $2)
          RETURNING id, name, type, created_at AS "createdAt"
        `,
        [type === 'group' ? requestedName : requestedName || null, type]
      );

      const room = createdRoom.rows[0];
      for (const memberId of uniqueMembers) {
        await client.query(
          'INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [room.id, memberId]
        );
      }

      await client.query('COMMIT');
      return res.status(201).json({
        id: room.id,
        name: room.name,
        type: room.type,
        unreadCount: 0,
        lastMessage: null,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      log(`Create room error: ${error.message}`);
      return res.status(500).json({ message: 'Unable to create room' });
    } finally {
      client.release();
    }
  });

  router.get('/:id/messages', async (req, res) => {
    const roomId = req.params.id;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const before = req.query.before ? String(req.query.before) : null;

    try {
      const membership = await pool.query(
        'SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2',
        [roomId, req.user.id]
      );

      if (!membership.rows[0]) {
        return res.status(404).json({ message: 'Room not found' });
      }

      const params = [roomId, limit];
      let beforeClause = '';

      if (before) {
        params.push(before);
        beforeClause = `
          AND m.created_at < (
            SELECT created_at
            FROM messages
            WHERE id = $3
              AND room_id = $1
          )
        `;
      }

      const { rows } = await pool.query(
        `
          SELECT
            m.id,
            m.room_id AS "roomId",
            m.sender_id AS "senderId",
            u.username AS "senderName",
            u.avatar_color AS "senderAvatarColor",
            m.content,
            m.media_url AS "mediaUrl",
            m.media_type AS "mediaType",
            m.status,
            m.created_at AS "createdAt"
          FROM messages m
          JOIN users u ON u.id = m.sender_id
          WHERE m.room_id = $1
          ${beforeClause}
          ORDER BY m.created_at DESC
          LIMIT $2
        `,
        params
      );

      return res.json(rows.reverse());
    } catch (error) {
      log(`Load messages error: ${error.message}`);
      return res.status(500).json({ message: 'Unable to load messages' });
    }
  });

  return router;
};
