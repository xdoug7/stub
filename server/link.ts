import cookie from 'cookie';
import { IncomingMessage, ServerResponse } from 'http';
import Redis from 'ioredis';

import { hasPasswordCookie, passwordValid, validPasswordCookie } from './decrypt';
import { getGeo } from './geoip';
import { getEmbedHTML, getPasswordPageHTML } from './html';
import { userAgentFromString } from './ua';
import { detectBot, parseUrl, serverRedirect, sendDeepLinkWithFallback } from './util';

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
      channel: 'intent://www.youtube.com/channel/$1#Intent;scheme=http;package=com.google.android.youtube;end',
      video: 'intent://www.youtube.com/watch?v=$1#Intent;scheme=http;package=com.google.android.youtube;end',
      shortVideo: 'intent://www.youtube.com/shorts/$1#Intent;scheme=http;package=com.google.android.youtube;end',
      liveVideo: 'intent://www.youtube.com/live/$1#Intent;scheme=http;package=com.google.android.youtube;end',
      playlist: 'intent://www.youtube.com/playlist?list=$1#Intent;scheme=http;package=com.google.android.youtube;end',
    },
  };

  // Detect the device type (iOS/Android) based on the user agent
  const deviceType = /iPhone|iPad|iPod/.test(userAgent) ? 'ios' : /Android/.test(userAgent) ? 'android' : 'other';

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
        return deepLink.replace('$1', match[2]);
      }
    }
  }

  // Log when no pattern matches, and the original URL is returned
  console.log('No matching pattern found. Returning original URL:', url);
  return url;
}

export default async function handleLink(req: IncomingMessage, res: ServerResponse) {
  const { hostname, key: linkKey, query } = parseUrl(req);

  const key = linkKey || ':index';
  if (!hostname) return false;

  // Get the IP
  let ip = req.socket.remoteAddress ?? '127.0.0.1';
  const cloudflareHeader = 'cf-connecting-ip'
  if (process.env.TRUST_PROXY === 'true') {
    const proxyHeader = process.env.TRUST_PROXY_HEADER || cloudflareHeader;
    if (proxyHeader && req.headers[proxyHeader]) {
      ip = Array.isArray(req.headers[proxyHeader]) ? req.headers[proxyHeader][0] : req.headers[proxyHeader];
    } else if (req.headers[cloudflareHeader]) {
      ip = Array.isArray(req.headers[cloudflareHeader]) ? req.headers[cloudflareHeader][0] : req.headers[cloudflareHeader];
    }
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

  // Check if the target URL is a YouTube link, and handle it accordingly
  const target = response?.url;

// Filter out the 'cookie' header
const filteredHeaders = { ...req.headers };
delete filteredHeaders.cookie;

console.log("===================================");
console.log(" Request Headers: ");
console.table(filteredHeaders);
console.log("===================================");
console.log(" Redis Key: ", `${hostname}:${key}`);
console.log("===================================");
console.log(" Target URL: ", target);
console.log("===================================");

  if (target) {
    const isBot = detectBot(req);

    console.log(" is Bot: ", isBot);
    console.log("===================================");

    // Check if the target URL is a YouTube link and if so, convert it to a deep link
    if (response.password) {
      if (await validPasswordCookie(req, hostname, key)) {
        serverRedirect(res, target);
      }
      else if (query.password !== '' && typeof query.password === 'string' && (await passwordValid(hostname, key, query.password))) {
        res.setHeader(
          'Set-Cookie',
          cookie.serialize('stub_link_password', query.password, {
            path: `/${encodeURIComponent(key)}`,
            expires: new Date(Date.now() + 604800000)
          })
        );
        serverRedirect(res, target);
      } else {
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
        const fallbackUrl = target;
        sendDeepLinkWithFallback(res, deepLink, fallbackUrl);
      } else {
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
