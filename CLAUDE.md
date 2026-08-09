# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Yarn 3 (Berry) is the package manager — always `yarn`, never `npm`. Node 18 is the floor (`.nvmrc`, Dockerfile, CI all agree); `sharp` and `tsx` refuse to install below it.

If your shell's default node is older, the corepack `yarn` shim fails with `URL.canParse is not a function` — run the pinned release directly: `node .yarn/releases/yarn-3.3.1.cjs <cmd>`.

```sh
yarn install            # add --ignore-engines if next-auth complains about the Node version
yarn generate           # prisma generate — required after any schema.prisma change
yarn migrate            # prisma migrate deploy + scripts/migrate.ts (v0.3 -> v0.4 Redis->Postgres backfill)
yarn dev                # Next.js app only, port 3000
yarn start:router       # link router only, port 3001 (tsx server/router.ts)
yarn start:all          # both, as production runs them
yarn lint               # eslint . — the only CI gate
yarn manage set-superadmin <email>
yarn preload-geolite    # download GeoLite2-City db; router geo lookups return "Userland" without it
```

There is no test suite. Verify changes with `yarn lint` and `yarn build`.

## Architecture

Fork of [Dub](https://github.com/steven-tey/dub), restructured to be self-hostable. Next.js 12 **pages router**, TypeScript, Tailwind, SWR on the client, zod for API input validation.

### Two processes, two runtimes

Dub routes links in Next.js edge middleware; that can't work with a non-HTTP Redis client, so Stub splits into:

1. **The app** (`pages/`, `components/`, `lib/`) — dashboard + JSON API, port 3000. `next.config.js` sets `basePath: '/control'`, so every app URL is served under `/control` (a fork-local deviation from upstream).
2. **The router** (`server/`) — a plain `node:http` server, port 3001 (`ROUTER_PORT`), that resolves `{host}{path}` to a target URL, redirects, and records the click. Domains point here, not at the app.

`server/` is a **separate runtime from Next.js** and must stay that way: it uses relative imports (the `@/lib/*` tsconfig aliases are not available there), loads `.env` itself via `server/env.ts`, and constructs its own Prisma and Redis clients. The apparent duplication between `server/*` and `lib/*` is deliberate — do not "de-duplicate" it by importing `@/lib/...` from `server/`.

### Where data lives

Postgres (Prisma) is the source of truth for users, projects, and links. Redis holds only what the router needs on the hot path plus analytics:

- `{domain}:{key}` — string, `{ url, password: boolean, proxy: boolean }`; expiry is a Redis `EXAT` mirroring `Link.expiresAt`.
- `{domain}:clicks:{key}` — sorted set of click records (geo, ua, referer, timestamp), scored by timestamp.
- `{domain}:root:clicks` — clicks for the domain root.

All keys are additionally prefixed by `REDIS_PREFIX` via ioredis `keyPrefix`.

**Every link mutation must write both stores.** `lib/api/links.ts` is the only correct place for this: `addLink`, `editLink`, `deleteLink`, `changeDomainForLinks`, `deleteProjectLinks`. Writing a `Link` row directly through Prisma leaves the router serving stale data or 404s.

`lib/redis.ts` still contains the pre-0.4 hash-based helpers (`{domain}:links` hash, `{domain}:links:timestamps` zset). Those are dead except for `redis` itself and `getLinkClicksCount` — use `lib/api/links.ts` instead.

`:index` is the reserved key for the domain root link.

### Auth

`lib/auth.ts` exports the wrappers every API route goes through:

- `withProjectAuth(handler)` — resolves the project from `req.query.slug` and passes `(req, res, project, session)`.
- `withUserAuth(handler, { needUserDetails, needSuperadmin })` — session-only routes; note it lets **all** `GET`s through before the superadmin check.
- `serverSidePropsAuth` — `getServerSideProps` redirect-to-`/login` guard.

`withProjectAuth` has two paths. The **API key path** fires when `x-api-key` matches `STUB_API_KEY`: it skips the session entirely, does one project lookup, and synthesizes `{ user: { id: STUB_API_KEY_USER_ID, superadmin: true } }` with an **empty `project.users` array**. Any route doing `project.users[0]?.role` must therefore also accept `session.user.superadmin`, or API-key calls will 403 (see `pages/api/projects/[slug]/links/index.ts`). The **session path** additionally distinguishes 404 / 409 (invite pending) / 410 (invite expired).

Permission layers: `User.superadmin` (instance-wide settings, bypasses project membership), `User.type` (`user` vs `admin` — controls project creation), and per-project `ProjectUsers.role` (`member` / `manager` / `owner`).

### Router request handling (`server/link.ts`)

For a resolved link, in order: password-protected links render an interactive HTML password page and set a `stub_link_password` cookie (`server/decrypt.ts`, `server/html.ts`); `proxy` links served to a detected bot get an OG-tag HTML page instead of a redirect; YouTube targets are rewritten to iOS/Android deep links with a JS fallback; everything else is a 302. The click is recorded after the response either way.

Client IP comes from `req.socket.remoteAddress` unless `TRUST_PROXY=true`, in which case `TRUST_PROXY_HEADER` (default `cf-connecting-ip`) is trusted. Geo is a local GeoLite2 lookup (`server/geoip.ts`), not a platform-provided header.

## Conventions

- Path aliases: `@/lib/*`, `@/components/*`, `@/pages/*`, `@/styles/*`. There is no alias for `server/`.
- API routes validate bodies with zod and return `{ error }` or `{ message, data }` on failure; unsupported methods set `Allow` and return 405.
- `tsconfig.json` has `strict: false` — types are loose, and API handlers cast zod output rather than infer it.
- ESLint (`eslint-config-snazzah`) enforces import ordering and is the CI blocker; run `yarn lint:fix` before pushing.

## Deployment

`Dockerfile` builds both processes into one image; the container entrypoint is `yarn migrate && yarn start:all`, exposing 3000 and 3001. `docker/docker-compose.yml` pairs it with Postgres and KeyDB. `.github/workflows/build.yml` pushes to GHCR on `master` and `v*` tags; `lint.yml` is the PR check. `pages/api/health.ts` backs the container healthcheck.
