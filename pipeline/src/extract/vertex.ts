/**
 * Gemini on Vertex AI over plain REST (no SDK, so the job bundle stays small).
 * Structured output via responseSchema; safety filters on (SDD §8.4 G5).
 */
import { getAccessToken } from '../gcp/auth';
import type { Llm, LlmRequest, LlmUsage } from '../types';

export interface VertexOptions {
  project: string;
  location: string;
  model: string;
  /** Gemini 2.5 thinking budget; 0 = off. Omitted = model default (dynamic thinking). */
  thinkingBudget?: number;
  /** Upper bound for answer (+ thinking) tokens. */
  maxOutputTokens?: number;
  fetchImpl?: typeof fetch;
  getToken?: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 4;
const BLOCK_FINISH = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST']);
const HARM_CATEGORIES = [
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
];

interface VertexPart {
  text?: string;
  thought?: boolean;
}
interface VertexResponse {
  candidates?: { content?: { parts?: VertexPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

export function vertexEndpoint(project: string, location: string, model: string): string {
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
}

/** Strip an optional ```json fence; models occasionally add one even in JSON mode. */
export function parseJsonText(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) t = fence[1];
  return JSON.parse(t);
}

const emptyUsage = (): LlmUsage => ({ calls: 0, promptTokens: 0, outputTokens: 0, thoughtsTokens: 0 });

export function createVertexLlm(opts: VertexOptions): Llm {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const getToken = opts.getToken ?? getAccessToken;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = vertexEndpoint(opts.project, opts.location, opts.model);
  const totals: Record<string, LlmUsage> = {};

  function buildBody(req: LlmRequest) {
    const generationConfig: Record<string, unknown> = {
      temperature: req.temperature ?? 0.2,
      responseMimeType: 'application/json',
      responseSchema: req.schema,
      maxOutputTokens: opts.maxOutputTokens ?? 8192,
    };
    if (opts.thinkingBudget !== undefined) generationConfig.thinkingConfig = { thinkingBudget: opts.thinkingBudget };
    return {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
      generationConfig,
      safetySettings: HARM_CATEGORIES.map((category) => ({ category, threshold: 'BLOCK_MEDIUM_AND_ABOVE' })),
    };
  }

  async function post(body: string): Promise<VertexResponse> {
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined;
      let netErr: unknown;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json' },
          body,
        });
      } catch (e) {
        netErr = e; // DNS/connection resets are transient; retry like a 503
      }
      if (res?.ok) return (await res.json()) as VertexResponse;
      if (attempt >= MAX_RETRIES || (res && !RETRYABLE.has(res.status))) {
        if (!res) throw new Error(`Vertex AI request failed: ${String(netErr)}`);
        throw new Error(`Vertex AI ${res.status}: ${await errorMessage(res)}`);
      }
      const retryAfter = Number(res?.headers.get('retry-after'));
      await sleep(retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 1000 * 2 ** attempt);
    }
  }

  return {
    model: opts.model,
    async generateJson<T>(req: LlmRequest) {
      const json = await post(JSON.stringify(buildBody(req)));
      const m = json.usageMetadata ?? {};
      const usage: LlmUsage = {
        calls: 1,
        promptTokens: m.promptTokenCount ?? 0,
        outputTokens: m.candidatesTokenCount ?? 0,
        thoughtsTokens: m.thoughtsTokenCount ?? 0,
      };
      const t = (totals[req.purpose] ??= emptyUsage());
      t.calls += 1;
      t.promptTokens += usage.promptTokens;
      t.outputTokens += usage.outputTokens;
      t.thoughtsTokens += usage.thoughtsTokens;

      const blockReason = json.promptFeedback?.blockReason;
      if (blockReason) return { data: null as T, usage, blocked: blockReason };
      const cand = json.candidates?.[0];
      if (!cand) throw new Error('Vertex AI returned no candidates');
      if (cand.finishReason && BLOCK_FINISH.has(cand.finishReason)) return { data: null as T, usage, blocked: cand.finishReason };
      const text = (cand.content?.parts ?? [])
        .filter((p) => !p.thought && typeof p.text === 'string')
        .map((p) => p.text)
        .join('');
      try {
        return { data: parseJsonText(text) as T, usage };
      } catch {
        throw new Error(`Vertex AI returned unparseable JSON (finishReason ${cand.finishReason ?? 'none'}): ${text.slice(0, 200)}`);
      }
    },
    usage() {
      return Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, { ...v }]));
    },
  };
}

async function errorMessage(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '');
  try {
    const j = JSON.parse(raw) as { error?: { message?: string } };
    if (j.error?.message) return j.error.message;
  } catch {
    /* not JSON */
  }
  return raw.slice(0, 300) || res.statusText;
}
