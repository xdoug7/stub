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

function handleYouTubeLink(url: string, userAgent: string) {
  // Log the input URL and User Agent
  console.log('Handling YouTube URL:', url);
  console.log('User Agent:', userAgent);

  // Define a set of regular expressions to match various YouTube URL patterns
  const patterns = {
    channel: [
      /^https:\/\/(www\.)?youtube\.com\/@(\w+)/,
      /^https:\/\/(www\.)?youtube\.com\/c\/(\w+)/,
    ],
    video: [
      /^https:\/\/(www\.)?youtube\.com\/watch\?v=([\w-]+)/,
      /^https:\/\/(www\.)?youtu\.be\/([\w-]+)/,
    ],
    shortVideo: [/^https:\/\/(www\.)?youtube\.com\/shorts\/([\w-]+)/],
    liveVideo: [/^https:\/\/(www\.)?youtube\.com\/live\/([\w-]+)/],
    playlist: [/^https:\/\/(www\.)?youtube\.com\/playlist\?list=([\w-]+)/],
  };

  // Define corresponding app deep link formats for iOS and Android
  const appLinks = {
    ios: {
      channel: 'youtube://channel/$1',
      video: 'youtube://video/watch?v=$1',
      shortVideo: 'youtube://video/shorts/$1',
      liveVideo: 'youtube://video/live/$1',
      playlist: 'youtube://playlist?list=$1',
    },
    android: {
      channel: 'youtube://channel/$1',
      video: 'youtube://watch?v=$1',
      shortVideo: 'youtube://shorts/$1',
      liveVideo: 'youtube://live/$1',
      playlist: 'youtube://playlist?list=$1',
    },
  };

  // Detect the device type (iOS/Android) based on the user agent
  const deviceType = /iPhone|iPad|iPod/.test(userAgent) ? 'ios' : /Android/.test(userAgent) ? 'android' : 'other';
  console.log('Detected Device Type:', deviceType);

  // Try to match the URL with each pattern and return the corresponding deep link
  for (const [category, regexes] of Object.entries(patterns)) {
    for (const pattern of regexes) {
      const match = url.match(pattern);
      if (match) {
        // If the device type is 'other', fall back to the original URL
        if (deviceType === 'other') {
          console.log(`No deep link for '${category}' category on device type 'other'. Returning original URL.`);
          return url;
        }
        
        const deepLink = appLinks[deviceType][category] || appLinks.ios[category];
        return deepLink.replace('$1', match[1]);
      }
    }
  }

  // Log when no pattern matches, and the original URL is returned
  console.log('No matching pattern found. Returning original URL:', url);
  return url;
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

  // Check if the target URL is a YouTube link, and handle it accordingly
  const target = response?.url;
  console.log('Target URL:', target);

  if (target) {
    const isBot = detectBot(req);
    console.log('Is Bot:', isBot);

    // Check if the target URL is a YouTube link and if so, convert it to a deep link
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
      // Check if the target URL is a YouTube link
      const youtubePattern = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)(\/|$)/;
      const isYouTubeLink = youtubePattern.test(target)
      console.log('Is YouTube? ', isYouTubeLink);
      if (isYouTubeLink) {
        const userAgent = req.headers['user-agent'] || '';
        const deepLink = handleYouTubeLink(target, userAgent);
        console.log('YouTube Deep Link:', deepLink);
        serverRedirect(res, deepLink);
      } else {
        console.log('Redirecting to target...');
        serverRedirect(res, target);
      }
    }
    await recordClick(hostname, req, ip, key);
  } else {
    console.log('Not Found. Sending 404...');
    res.statusCode = 404;
    res.end('Not Found');
  }
  return true;
}
