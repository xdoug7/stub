import { IncomingMessage, ServerResponse } from 'node:http';
import { parse } from 'node:url';

export function parseUrl(req: IncomingMessage) {
  const hostname = req.headers['host'];
  const parsedUrl = parse(req.url, true);
  const { pathname, query } = parsedUrl;
  const key = decodeURIComponent(pathname.slice(1));
  return {
    hostname,
    path: pathname,
    key,
    query,
    parsedUrl
  };
}

export function serverRedirect(res: ServerResponse, location: string, status = 302) {
  res.setHeader('location', location);
  res.statusCode = status;
  res.end();
}

export function sendDeepLinkWithFallback(res: ServerResponse, deepLink: string, fallbackUrl: string) {
  const html = `
    <html>
      <head>
        <script>
          var deepLink = '${deepLink}';
          var fallbackUrl = '${fallbackUrl}';
          var timeout;

          function openDeepLink() {
            document.location = deepLink;
            timeout = setTimeout(function() {
              document.location = fallbackUrl;
            }, 1000);
          }

          function clearFallback() {
            clearTimeout(timeout);
          }

          window.addEventListener('pagehide', clearFallback);
          setTimeout(openDeepLink, 0);
        </script>
      </head>
      <body></body>
    </html>
  `;

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html');
  res.end(html);
}


export const detectBot = (req: IncomingMessage) => {
  const ua = req.headers['user-agent'];
  console.info(`Validating bot for User Agent: ${ua}`)
  if (ua) {
    /* Note:
     * - bot is for most bots & crawlers
     * - ChatGPT is for ChatGPT
     * - facebookexternalhit is for Facebook crawler
     * - WhatsApp is for WhatsApp crawler
     * - MetaInspector is for https://metatags.io/
     */
    return /bot|chatgpt|facebookexternalhit|WhatsApp|google|baidu|bing|msn|duckduckbot|teoma|slurp|yandex|MetaInspector/i.test(ua);
  }
  return false;
};
