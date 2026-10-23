[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md)

# Creator Operations

**Keep creator outreach, partnership progress and team coordination in one ecommerce workbench.**

By xiaoyu312 · [FateClear — free birthday charting and interpretation website](https://fateclear.com) · [X — the author's projects and updates](https://x.com/liu_xiaoyu27334)

A workbench for ecommerce partnership teams, creator operations and team leads: outreach, follow-up, samples, partnerships, schedules, sales attribution and team coordination in one workflow. This package contains the original React workbench, domain service and APIs, a deterministic local demo, and an independently usable Manifest V3 Creator Assistant.

**The default is a local synthetic demo that resets on restart.** No real workbooks, contacts, orders, accounts, secrets or private assets are included. Optional platform adapter sources are retained; this is not a verified enterprise production deployment.

## Start with a synthetic example

With a repository copy and Node.js 24 or newer, run this standalone example from the repository root; it does not require application dependencies:

```sh
npm run demo:assistant
```

The [example source](examples/assistant-demo.mjs) creates 2 fictional creators and generates 2 unsent invitation drafts. The following expected output is derived from its source and assertions; this documentation pass did not execute the command:

```json
{
  "mode": "synthetic-only",
  "creators": 2,
  "unsentDrafts": 2,
  "network": "none",
  "browser": "not opened",
  "persisted": false
}
```

This example opens no browser, makes no network requests, persists no records and sends no invitations. It demonstrates the independent Creator Assistant draft workflow. The workbench also includes a [synthetic API example](examples/demo.ts) and [fixed-seed generator](examples/generate-demo.ts). Application setup and verification limits follow below.

## Run the workbench

Use Node.js 24 or newer. After installing dependencies:

```sh
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. The frontend proxies the local API at `127.0.0.1:4310`. Switch demo roles in the UI to explore permissions, creator follow-up, samples, partnerships, schedules, teams and products. Original commands, CSV preview/commit, exports and audit rules are retained. Initial records are fixed synthetic fixtures; orders start empty. Data deliberately imported by the user remains only in process memory.

No `.env` is required. To change the API port, use the root `.env.example` as a template for your own `.env` and set `DABO_DEMO_API_PORT`. The `dev` and `start` scripts explicitly load it. Never commit real environment settings.

Build and preview locally:

```sh
npm run build:client
npm start
```

The demo binds only to loopback and rejects production/platform runtime mode. It uses local session cookies, CSRF validation and bounded requests. It has no persistence and is not a public deployment entry point.

## Included sources

| Directory | Contents |
|---|---|
| `client/` | Original React workbench, pages, interaction models, charts, UI components and styles |
| `server/domain/`, `shared/` | Original commands, permissions, state transitions, imports, attribution and synthetic seed |
| `server/demo/`, `server/http/` | Added local sessions, in-memory adapter and HTTP entry connected to the original API service |
| `server/modules/`, `server/storage/`, `server/invitations/`, `server/platform/` | API and optional Nest, database, identity and member-invitation adapters |
| `extensions/creator-assistant/` | Complete independent extension sources and mocked tests |
| `tests/`, `server/tests/` | Domain, client-model, API, role-boundary and in-process frontend/backend contract tests |
| `examples/` | Deterministic synthetic generator and small API examples |
| `licenses/` | Upstream and direct-dependency notices; no dependency implementations |

The original `shared/seed.ts` is manually authored synthetic data. `examples/generate-demo.ts` produces the same data with a fixed seed identifier. No private workbook was renamed, sampled or de-identified to create the demo. Contacts, orders and audit appear as schema and behavior, not actual business records. Private images and deployment-object references were replaced with an original placeholder SVG.

## Creator Assistant

[简体中文](extensions/creator-assistant/README.md) · [English](extensions/creator-assistant/README.en.md) · [日本語](extensions/creator-assistant/README.ja.md)

```sh
npm run build:assistant
npm run test:assistant
```

The build only joins the owned `adapters.js` and `page-hook.js` into `capture-main.js`. Load the directory manually in a separate Chrome/Edge test profile. No workbench backend is required; first-run storage is empty.

The extension locally collects creators and follow-up from authorized Douyin, Weixin Channels, Xiaohongshu and Kuaishou pages. Explicitly started Douyin/Weixin invitation workflows use the current platform session and communicate with real platforms. The complete extension is therefore not offline. See its documentation for permissions, failure handling and data storage.

## Optional platform integration

The default workbench does not load live platform profiles or enable production member invitations. Original brand, workbook and member pages remain conditional branches. `VITE_ENABLE_PLATFORM_INTEGRATIONS` defaults to `false`; documentation and profile SDK URLs default to blank. Never place secrets in browser-visible `VITE_*` settings.

An integrator must supply trusted authentication/CSRF middleware, organization/application IDs, server-side role mappings, a CSV preview-signing secret, workbook credentials and a brand registry, reviewed database schema/RPC migrations and the platform role SDK. Compose and configure these optional modules in your own production bootstrap. **The complete enterprise AppModule, workbook persistence service and database migrations are not included.** A feature flag is not a finished integration; browser-provided identity must never replace verified server context. Read the [backend scope (Chinese)](server/README.md).

`@lark-apaas/client-toolkit@1.2.74` builds the retained platform pages. This exact version was confirmed in the official public npm registry; the default local pages do not trigger its live platform workflows. Optional server packages are declared as optional peers. SDK terms remain their own; their implementations are not bundled or relicensed.

## Verification and limits

```sh
npm test
npm run test:assistant
npm run typecheck
npm run demo
npm run demo:assistant
npm run generate:demo
```

Historical results from source preparation: local verification with outbound network and listening sockets disabled passed **154 app tests** and **164 extension tests**. The actual frontend Vite configuration built successfully; client and backend typechecks passed. These checks resolved the original project's installed dependencies read-only. No dependency installation, browser or real service was started then. This multilingual documentation pass performed static checks only; it did not rerun those tests, builds or typechecks.

- A clean `npm install` is unverified and no new lockfile is included. Direct versions are pinned; transitive versions can still change.
- Large frontend chunks remain. Browser interaction, visual quality, performance and Windows were not validated here.
- Real login, platform profile lookup, invitation delivery, database migrations/RPCs and production deployment are unverified.
- Some adversarial tests contain clearly fake tokens, phone strings and long integers to exercise redaction, precision and rejection rules; these are not runtime credentials.
- Runtime imports, exports, browser storage and backups are the user's responsibility and must stay out of source control.

## Documentation and source entry points

- [Commands and dependencies](package.json): Node.js requirements and development, build, test and demo scripts.
- [Backend scope (Chinese)](server/README.md): local demo boundaries and requirements for optional production modules.
- [Synthetic seed](shared/seed.ts) and [demo generator](examples/generate-demo.ts): where the initial records come from.
- [Independent Creator Assistant](extensions/creator-assistant/README.en.md): installation, platform permissions, live invitations and local data storage.

## License

User-owned implementation and new documentation use MIT, copyright 2026 xiaoyu312. Original Lark template, shadcn/ui and dependency notices are preserved. See [license scope](LICENSE-STATUS.md) and [third-party notices](THIRD_PARTY_NOTICES.md). MIT does not grant third-party platform, trademark, API or data access rights.

Explore [FateClear — free birthday charting and interpretation website](https://fateclear.com), or follow the author's projects and updates on [X](https://x.com/liu_xiaoyu27334).
