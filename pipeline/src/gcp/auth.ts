/**
 * Google access tokens without service account keys:
 *  - on Cloud Run: the metadata server (the job's service account)
 *  - locally: ACCESS_TOKEN env, else `gcloud auth print-access-token`
 */
import { execFileSync } from 'node:child_process';

let cached: { token: string; expires: number } | null = null;

export async function getAccessToken(): Promise<string> {
  if (process.env.ACCESS_TOKEN) return process.env.ACCESS_TOKEN;
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  try {
    const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(2000),
    });
    if (r.ok) {
      const j = (await r.json()) as { access_token: string; expires_in: number };
      cached = { token: j.access_token, expires: Date.now() + j.expires_in * 1000 };
      return j.access_token;
    }
  } catch {
    /* not on GCP: fall through to gcloud */
  }
  const token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
  cached = { token, expires: Date.now() + 30 * 60_000 };
  return token;
}
