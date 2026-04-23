class PresenceManager {
  constructor({ redis, publisher, pool, log }) {
    this.redis = redis;
    this.publisher = publisher;
    this.pool = pool;
    this.log = log;
  }

  async setOnline(user) {
    await this.redis.set(`presence:${user.id}`, 'online', { EX: 30 });
    await this.publisher.publish(
      'presence-channel',
      JSON.stringify({
        userId: user.id,
        username: user.username,
        status: 'online',
      })
    );
  }

  async refresh(user) {
    await this.redis.set(`presence:${user.id}`, 'online', { EX: 30 });
  }

  async setOffline(user) {
    await this.redis.del(`presence:${user.id}`);
    await this.publisher.publish(
      'presence-channel',
      JSON.stringify({
        userId: user.id,
        username: user.username,
        status: 'offline',
      })
    );
  }

  async setTyping(roomId, userId, isTyping) {
    const key = `typing:${roomId}:${userId}`;

    if (isTyping) {
      await this.redis.set(key, '1', { EX: 5 });
      return;
    }

    await this.redis.del(key);
  }

  async listOnlineUsers() {
    const keys = await this.redis.keys('presence:*');

    if (!keys.length) {
      return [];
    }

    const userIds = keys.map((key) => key.replace('presence:', ''));
    const { rows } = await this.pool.query(
      `
        SELECT id AS "userId", username
        FROM users
        WHERE id = ANY($1::uuid[])
      `,
      [userIds]
    );

    return rows.map((row) => ({
      ...row,
      status: 'online',
    }));
  }
}

module.exports = PresenceManager;
