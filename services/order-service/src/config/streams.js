const Redis = require('ioredis');
const { hostname } = require('node:os');
const { randomUUID } = require('node:crypto');

let redis;
const getRedis = () => {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      commandTimeout: 3000
    });
    redis.on('error', (error) => console.error('[streams]', error.message));
  }
  return redis;
};

const createBlockingClient = (commands) => {
  if (commands && typeof commands.duplicate === 'function') {
    return commands.duplicate({ maxRetriesPerRequest: null, enableOfflineQueue: false });
  }
  const client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: null,
    connectTimeout: 5000,
  });
  client.on('error', (error) => console.error('[blocking reader]', error.message));
  return client;
};

// A blocking read needs its own connection; it must not block XADD/XACK.
async function consumeStream(stream, group, handle) {
  const commands = getRedis();
  const reader = createBlockingClient(commands);
  reader.on('error', (error) => console.error(`[${group} reader]`, error.message));
  await reader.connect();
  const consumer = `${hostname()}-${process.pid}-${randomUUID()}`;
  let stopping = false;
  let cursor = '0-0';
  async function ensureGroup() {
    try {
      await commands.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
    } catch (error) {
      if (!error.message.includes('BUSYGROUP')) throw error;
    }
  }
  await ensureGroup();

  const batchSize = Number(process.env.STREAM_BATCH_SIZE) || 20;

  const done = (async () => {
    while (!stopping) {
      try {
        // Retry work abandoned by a crashed consumer (including this consumer).
        const claimed = await reader.xautoclaim(stream, group, consumer, 60000, cursor, 'COUNT', batchSize);
        cursor = claimed[0];
        let messages = claimed[1];
        if (!messages.length) {
          const batch = await reader.xreadgroup('GROUP', group, consumer,
            'COUNT', batchSize, 'BLOCK', 1000, 'STREAMS', stream, '>');
          messages = batch ? batch[0][1] : [];
        }

        if (messages.length > 0) {
          if (handle.length <= 2) {
            // Batch processing mode
            const parsedBatch = messages.map(([id, fields]) => {
              const event = {};
              for (let i = 0; i < fields.length; i += 2) event[fields[i]] = fields[i + 1];
              return { id, event };
            });
            await handle(parsedBatch, commands);
          } else {
            // Legacy single-message callback mode (backward compatible with unit tests)
            for (const [id, fields] of messages) {
              const event = {};
              for (let i = 0; i < fields.length; i += 2) event[fields[i]] = fields[i + 1];
              await handle(event, id, commands);
            }
          }
        }
      } catch (error) {
        if (stopping) break;
        console.error(`[${group}] Leaving message pending:`, error.message);
        if (error.message.includes('NOGROUP')) {
          await ensureGroup().catch((err) => console.error('[streams]', err.message));
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  })();
  return async () => {
    stopping = true;
    // BLOCK is bounded to one second. Finish an in-flight handler before quitting.
    await done;
    reader.disconnect();
  };
}

module.exports = { getRedis, createBlockingClient, consumeStream };
