/**
 * Structured logging for Cloud Logging: one JSON object per line on stdout/stderr.
 * Cloud Run Jobs turn `severity` and `message` into the entry's severity and summary, and the
 * remaining keys into jsonPayload fields (used by the log-based metrics and the digest alert).
 */
export type Severity = 'DEBUG' | 'INFO' | 'NOTICE' | 'WARNING' | 'ERROR';

let quiet = false;
export function setQuiet(q: boolean) {
  quiet = q;
}

export function log(severity: Severity, message: string, fields: Record<string, unknown> = {}): void {
  if (quiet && severity !== 'ERROR') return;
  const line = JSON.stringify({ severity, message, component: 'babysteps-pipeline', ...fields });
  if (severity === 'ERROR' || severity === 'WARNING') console.error(line);
  else console.log(line);
}

export const info = (m: string, f?: Record<string, unknown>) => log('INFO', m, f);
export const warn = (m: string, f?: Record<string, unknown>) => log('WARNING', m, f);
export const error = (m: string, f?: Record<string, unknown>) => log('ERROR', m, f);
