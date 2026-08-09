import { NextApiRequest, NextApiResponse } from 'next';

import { withProjectAuth } from '@/lib/auth';
import { redis } from '@/lib/redis';
import { intervalData, IntervalProps, processData, RawStatsProps } from '@/lib/stats';

const keyPrefix = process.env.REDIS_PREFIX ?? '';

export default withProjectAuth(async (req: NextApiRequest, res: NextApiResponse, project) => {
  if (req.method === 'GET') {
    const { interval } = req.query as { interval: IntervalProps };
    const start = Date.now() - intervalData[interval || '24h'].milliseconds;
    const end = Date.now();

    // SCAN patterns bypass ioredis' keyPrefix, so it's applied here and stripped back off the results
    const pattern = `${keyPrefix}${project.domain}:clicks:*`;
    const raw: RawStatsProps[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      for (const key of keys) {
        const clicks = await redis
          .zrangebyscore(key.slice(keyPrefix.length), start, end)
          .then((r) => r.map((s) => JSON.parse(s) as RawStatsProps));
        raw.push(...clicks);
      }
    } while (cursor !== '0');

    return res.status(200).json(processData(project.domain, raw, interval));
  } else {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }
});
