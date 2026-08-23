import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import { app } from '../src/api/server.js';
import { store } from '../src/store/store.js';
import { seed } from '../src/store/seed.js';

/**
 * UI ↔ API contract.
 *
 * The client and the server are edited independently, so the cheapest way for
 * this app to break is for the UI to call a path the server does not route —
 * a failure no service-level test can see, and one that only shows up as a
 * blank panel in the browser.
 *
 * This suite reads the actual endpoint list out of `web/src/api.ts` and proves
 * every one of them resolves, and that the built bundle is really being served.
 */

let server: Server;
let base: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  store.reset();
  seed();
});

const API_CLIENT = readFileSync(resolve(process.cwd(), 'web/src/api.ts'), 'utf8');

/** Pull every `/api/...` path literal the client can request. */
function declaredEndpoints(): string[] {
  const paths = new Set<string>();
  for (const m of API_CLIENT.matchAll(/['"`](\/api\/[^'"`]*)['"`]/g)) {
    paths.add(m[1]!);
  }
  return [...paths];
}

/** Replace `${...}` template holes with a value that will resolve. */
function concretise(path: string): string {
  return path
    .replace(/\$\{carrier\}/g, '6E')
    .replace(/\$\{encodeURIComponent\(ref\)\}/g, 'CFB-XXXXXX')
    .replace(/\$\{id\}/g, 'bkg_unknown')
    .replace(/\$\{[^}]+\}/g, 'placeholder');
}

describe('every endpoint the UI calls is routed by the server', () => {
  it('finds the client endpoint list', () => {
    const eps = declaredEndpoints();
    expect(eps.length).toBeGreaterThan(10);
    expect(eps).toContain('/api/search');
    expect(eps).toContain('/api/reports/dashboard');
  });

  it('routes all of them — no 404 from an unknown path', async () => {
    const missing: string[] = [];

    for (const raw of declaredEndpoints()) {
      const path = concretise(raw);

      // Try GET then POST/PUT/DELETE; a routed path answers something other
      // than Express's default 404-for-unmatched-route.
      let routed = false;
      for (const method of ['GET', 'POST', 'PUT', 'DELETE'] as const) {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }),
        });
        // 404 with a JSON DomainError body means the ROUTE exists and the
        // resource does not — that still counts as routed.
        if (res.status !== 404) {
          routed = true;
          break;
        }
        const body = await res.text();
        if (body.includes('"code"')) {
          routed = true;
          break;
        }
      }
      if (!routed) missing.push(raw);
    }

    expect(missing, `UI calls endpoints the server does not route: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('the built UI is served and wired up', () => {
  it('serves index.html with the React root', async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('<div id="root">');
    expect(html).toContain('ConsultCo Travel');
  });

  it('serves the hashed JS and CSS assets referenced by index.html', async () => {
    const html = await (await fetch(`${base}/`)).text();

    const js = html.match(/src="(\/assets\/[^"]+\.js)"/);
    const css = html.match(/href="(\/assets\/[^"]+\.css)"/);
    expect(js, 'index.html must reference a JS bundle').toBeTruthy();
    expect(css, 'index.html must reference a CSS bundle').toBeTruthy();

    expect((await fetch(`${base}${js![1]}`)).status).toBe(200);
    expect((await fetch(`${base}${css![1]}`)).status).toBe(200);
  });

  it('the bundle contains the screens and copy the demo depends on', async () => {
    const html = await (await fetch(`${base}/`)).text();
    const jsPath = html.match(/src="(\/assets\/[^"]+\.js)"/)![1]!;
    const bundle = await (await fetch(`${base}${jsPath}`)).text();

    // If a build ever drops one of these, the demo script in the README breaks.
    for (const marker of [
      'Ranked by total cost to the company',
      'Corporate fares could not be checked',
      'BEST TOTAL COST',
      'Why not the corporate fare?',
      'Out of policy',
      'GSTR-2B reconciliation',
      'Corporate fare query health',
      'Keep this reference',
    ]) {
      expect(bundle, `UI bundle is missing: ${marker}`).toContain(marker);
    }
  });

  it('falls back to the SPA shell for a client-side route', async () => {
    const res = await fetch(`${base}/some/deep/link`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
  });

  it('does not shadow the API with the SPA fallback', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
