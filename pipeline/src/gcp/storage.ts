/**
 * Minimal Cloud Storage client over the JSON API (no SDK, no keys) plus an in-memory bucket for tests.
 * The pipeline owns these prefixes in the content bucket: catalog/, content/, state/.
 */
import { getAccessToken } from './auth';

export interface StoredObject {
  body: string;
  generation: string;
}

export interface WriteOptions {
  contentType?: string;
  /** Precondition: only write if the current generation matches ("0" = must not exist). */
  ifGenerationMatch?: string;
}

export interface Bucket {
  readonly name: string;
  read(path: string): Promise<StoredObject | null>;
  write(path: string, body: string, opts?: WriteOptions): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export async function readJson<T>(b: Bucket, path: string): Promise<T | null> {
  const o = await b.read(path);
  return o ? (JSON.parse(o.body) as T) : null;
}

export async function writeJson(b: Bucket, path: string, value: unknown, opts: WriteOptions = {}): Promise<void> {
  await b.write(path, JSON.stringify(value, null, path.startsWith('catalog/') ? undefined : 1), {
    contentType: 'application/json',
    ...opts,
  });
}

export class PreconditionFailed extends Error {}

const API = 'https://storage.googleapis.com';

export class GcsBucket implements Bucket {
  constructor(
    readonly name: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly token: () => Promise<string> = getAccessToken,
  ) {}

  private async call(url: string, init: RequestInit = {}, attempt = 1): Promise<Response> {
    const r = await this.fetchImpl(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${await this.token()}` },
    });
    if ((r.status === 429 || r.status >= 500) && attempt < 4) {
      await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
      return this.call(url, init, attempt + 1);
    }
    return r;
  }

  async read(path: string): Promise<StoredObject | null> {
    const r = await this.call(`${API}/storage/v1/b/${this.name}/o/${encodeURIComponent(path)}?alt=media`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`gcs read ${path}: ${r.status} ${await r.text()}`);
    return { body: await r.text(), generation: r.headers.get('x-goog-generation') ?? '' };
  }

  async write(path: string, body: string, opts: WriteOptions = {}): Promise<void> {
    const q = new URLSearchParams({ uploadType: 'media', name: path });
    if (opts.ifGenerationMatch !== undefined) q.set('ifGenerationMatch', opts.ifGenerationMatch);
    const r = await this.call(`${API}/upload/storage/v1/b/${this.name}/o?${q}`, {
      method: 'POST',
      headers: { 'Content-Type': opts.contentType ?? 'application/json' },
      body,
    });
    if (r.status === 412) throw new PreconditionFailed(`gcs write ${path}: generation changed`);
    if (!r.ok) throw new Error(`gcs write ${path}: ${r.status} ${await r.text()}`);
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let pageToken = '';
    do {
      const q = new URLSearchParams({ prefix, fields: 'items(name),nextPageToken' });
      if (pageToken) q.set('pageToken', pageToken);
      const r = await this.call(`${API}/storage/v1/b/${this.name}/o?${q}`);
      if (!r.ok) throw new Error(`gcs list ${prefix}: ${r.status} ${await r.text()}`);
      const j = (await r.json()) as { items?: { name: string }[]; nextPageToken?: string };
      for (const it of j.items ?? []) out.push(it.name);
      pageToken = j.nextPageToken ?? '';
    } while (pageToken);
    return out;
  }
}

/** In-memory bucket with generations and preconditions, for tests and local dry runs. */
export class MemoryBucket implements Bucket {
  readonly objects = new Map<string, StoredObject>();
  private gen = 1;
  writes: string[] = [];
  /** Paths whose next write should fail (to test partial uploads). */
  failWrites = new Set<string>();

  constructor(readonly name = 'memory') {}

  async read(path: string) {
    const o = this.objects.get(path);
    return o ? { ...o } : null;
  }

  async write(path: string, body: string, opts: WriteOptions = {}) {
    if (this.failWrites.has(path)) {
      this.failWrites.delete(path);
      throw new Error(`simulated write failure ${path}`);
    }
    const cur = this.objects.get(path);
    if (opts.ifGenerationMatch !== undefined) {
      const want = opts.ifGenerationMatch;
      if ((want === '0' && cur) || (want !== '0' && cur?.generation !== want)) throw new PreconditionFailed(path);
    }
    this.objects.set(path, { body, generation: String(this.gen++) });
    this.writes.push(path);
  }

  async list(prefix: string) {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}
