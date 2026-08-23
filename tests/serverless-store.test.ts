import { describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from '../src/store/store.js';
import { SEED_ORGANISATION } from '../src/store/seed.js';

/**
 * Serverless storage mode.
 *
 * Vercel and Lambda give a read-only filesystem and no durable local disk, so
 * the JSON store cannot write there — it throws rather than degrading. Memory
 * mode exists for that, and these tests pin the two properties that matter:
 * it never touches the filesystem, and it still behaves like a store.
 *
 * The limitation is real and deliberate: state lives only as long as the warm
 * instance. That is acceptable for a demo whose data is fabricated; it is why a
 * production deployment puts a database behind this same interface.
 */
const SCRATCH = resolve(process.cwd(), 'data', 'db.memorymode.test.json');

describe('memory mode never touches the filesystem', () => {
  it('writes no file even after mutations', () => {
    rmSync(SCRATCH, { force: true });
    const store = new Store(SCRATCH, true);

    store.setOrganisation(structuredClone(SEED_ORGANISATION));
    store.putSession({
      id: 'sess_x',
      legalEntityId: 'le_karnataka',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    store.raiseAlert({
      id: 'alr_x',
      at: new Date().toISOString(),
      severity: 'WARN',
      code: 'TEST',
      message: 'test',
      acknowledged: false,
    });

    expect(existsSync(SCRATCH), 'memory mode must not create a store file').toBe(false);
  });

  it('still reads back what it stored', () => {
    const store = new Store(SCRATCH, true);
    store.setOrganisation(structuredClone(SEED_ORGANISATION));

    expect(store.getOrganisation().name).toBe(SEED_ORGANISATION.name);
    expect(store.getLegalEntity('le_karnataka')?.gstin).toBe('29AABCC1234D1Z5');
  });

  it('ignores an existing file rather than loading it', () => {
    // A stale file from a previous file-mode run must not leak into memory mode.
    const fileStore = new Store(SCRATCH, false);
    fileStore.setOrganisation({ ...structuredClone(SEED_ORGANISATION), name: 'FROM DISK' });
    expect(existsSync(SCRATCH)).toBe(true);

    const memStore = new Store(SCRATCH, true);
    expect(memStore.isEmpty()).toBe(true);

    rmSync(SCRATCH, { force: true });
  });
});

describe('cold-start detection', () => {
  it('reports empty before seeding and populated after', () => {
    const store = new Store(SCRATCH, true);
    // The serverless entry point uses this to decide whether to seed.
    expect(store.isEmpty()).toBe(true);
    store.setOrganisation(structuredClone(SEED_ORGANISATION));
    expect(store.isEmpty()).toBe(false);
  });

  it('throws a clear error when read before configuration', () => {
    const store = new Store(SCRATCH, true);
    expect(() => store.getOrganisation()).toThrow(/not configured/i);
  });
});

describe('file mode still persists, for container hosts with a volume', () => {
  it('round-trips through the filesystem', () => {
    rmSync(SCRATCH, { force: true });

    const a = new Store(SCRATCH, false);
    a.setOrganisation({ ...structuredClone(SEED_ORGANISATION), name: 'PERSISTED' });
    expect(existsSync(SCRATCH)).toBe(true);

    const b = new Store(SCRATCH, false);
    expect(b.getOrganisation().name).toBe('PERSISTED');

    rmSync(SCRATCH, { force: true });
  });
});
