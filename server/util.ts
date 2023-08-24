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
      <body>

      <script>
          var deepLink = '${deepLink}';
          var fallbackUrl = '${fallbackUrl}';
          var timeout;
          window.onload = function() {
            // Deep link to your app goes here
            document.getElementById("l").src = deepLink;

            setTimeout(function() {
                // Link to the App Store should go here -- only fires if deep link fails                
                window.location = fallbackUrl;
            }, 500);
        };
        </script>

        <iframe id="l" width="1" height="1" style="visibility:hidden"></iframe>
      </body>
    </html>
  `;

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html');
  res.end(html);
}


export const detectBot = (req: IncomingMessage) => {
  const ua = req.headers['user-agent'];
  if (ua) {
    return /bot|crawler|spider|chatgpt|facebookexternalhit|WhatsApp|google|baidu|bing|msn|duckduckbot|teoma|slurp|yandex|MetaInspector|Twitterbot|Yahoo|AhrefsBot/i.test(ua);
  }
  return false;
};
