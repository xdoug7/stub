import cookie from 'cookie';
import { IncomingMessage, ServerResponse } from 'http';
import Redis from 'ioredis';

import { hasPasswordCookie, passwordValid, validPasswordCookie } from './decrypt';
import { getGeo } from './geoip';
import { getEmbedHTML, getPasswordPageHTML } from './html';
import { userAgentFromString } from './ua';
import { detectBot, parseUrl, serverRedirect } from './util';

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: parseInt(process.env.REDIS_PORT, 10) || 6379,
  keyPrefix: process.env.REDIS_PREFIX ?? '',
  password: process.env.REDIS_PASSWORD
});

/** Recording clicks with geo, ua, referer and timestamp data **/
export async function recordClick(hostname: string, req: IncomingMessage, ip: string, key: string) {
  const now = Date.now();
  return await redis.zadd(
    `${hostname}:clicks:${key}`,
    'NX',
    now,
    JSON.stringify({
      geo: getGeo(ip),
      ua: userAgentFromString(req.headers['user-agent']),
      referer: req.headers.referer,
      timestamp: now
    })
  );
}

export default async function handleLink(req: IncomingMessage, res: ServerResponse) {
  const { hostname, key: linkKey, query } = parseUrl(req);
  console.log('Parsed URL:', { hostname, key: linkKey, query });

  const key = linkKey || ':index';
  if (!hostname) return false;

  // Get the IP
  let ip = req.socket.remoteAddress ?? '127.0.0.1';
  console.log('Initial IP:', ip);
  if (process.env.TRUST_PROXY === 'true') {
    const proxyHeader = process.env.TRUST_PROXY_HEADER || 'cf-connecting-ip';
    if (proxyHeader && req.headers[proxyHeader])
      ip = Array.isArray(req.headers[proxyHeader]) ? req.headers[proxyHeader][0] : (req.headers[proxyHeader] as string);
    console.log('Proxy IP:', ip);
  }

  const response = await redis.get(`${hostname}:${key}`).then((r) => {
    if (r !== null)
      return JSON.parse(r) as {
        url: string;
        password?: boolean;
        proxy?: boolean;
      };
    return null;
  });
  console.log('Response from Redis:', response);

  const target = response?.url;
  console.log('Target URL:', target);

  if (target) {
    const isBot = detectBot(req);
    console.log('Is Bot:', isBot);
    if (response.password) {
      if (await validPasswordCookie(req, hostname, key)) {
        console.log('Valid password cookie. Redirecting...');
        serverRedirect(res, target);
      }
      else if (query.password !== '' && typeof query.password === 'string' && (await passwordValid(hostname, key, query.password))) {
        console.log('Password query valid. Redirecting...');
        res.setHeader(
          'Set-Cookie',
          cookie.serialize('stub_link_password', query.password, {
            path: `/${encodeURIComponent(key)}`,
            expires: new Date(Date.now() + 604800000)
          })
        );
        serverRedirect(res, target);
      } else {
        console.log('Password required. Sending password page...');
        res.statusCode = 200;
        if (hasPasswordCookie(req))
          res.setHeader(
            'Set-Cookie',
            cookie.serialize('stub_link_password', '', {
              path: `/${encodeURIComponent(key)}`,
              expires: new Date(1)
            })
          );
        res.end(getPasswordPageHTML(typeof query.password === 'string' ? query.password : undefined));
      }
    } else if (response.proxy && isBot) {
      console.log('Proxying for bot. Sending embed HTML...');
      res.statusCode = 200;
      res.end(await getEmbedHTML(res, hostname, key));
    } else {
      console.log('Redirecting to target...');
      serverRedirect(res, target);
    }
    await recordClick(hostname, req, ip, key);
  } else {
    console.log('Not Found. Sending 404...');
    res.statusCode = 404;
    res.end('Not Found');
  }
  return true;
}
