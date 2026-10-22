/**
 * Stenographer — the decision model client
 *
 * A decision model answers typed questions over a state in one forward
 * pass, with no generated text: `choice` (one of named options), `noul`
 * (yes or no, as a probability) and `score` (an ordered level). Three
 * servers speak the same System One wire (`POST {base}/v1/systemone`):
 * TypeSafe's Jev (`jev`), Liquid AI's open-weight d1 models under
 * llama.cpp's llama-server (`d1`, what `smallchat judge serve` runs), and
 * any endpoint of the operator's (`<url>`). Stenographer uses one as an
 * adviser — a second opinion on objections, and an answer to an agent that
 * asks before asserting — never as an authority: nothing it says enters the
 * ledger, and a person's ruling is what grades it (advisor.ts).
 *
 * Data egress: a request carries the state the caller built (state.ts:
 * the assertion, the tombstones that bear on it and recent transcript
 * lines) to the model's base URL. It is loopback by default (`d1`); a
 * remote URL takes `allowRemote`, and https. A key, when there is one,
 * travels only in the Authorization header and is never logged or
 * serialized.
 */

export const SYSTEM_ONE_PATH = '/v1/systemone';
export const DEFAULT_D1_BASE_URL = 'http://127.0.0.1:8080';
export const DEFAULT_JEV_BASE_URL = 'https://api.typesafe.ai';
export const DEFAULT_JEV_MODEL = 'jev-1.13.0';
export const DEFAULT_D1_MODEL = 'd1-omni-600M';
export const DEFAULT_DECISION_TIMEOUT_MS = 4_000;
/** Largest response body read. */
const MAX_RESPONSE_BYTES = 64 * 1024;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;
const API_KEY = /^[\x21-\x7e]+$/;

/** A question as the Decision Index schema has it. */
export type DecisionQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export type DecisionAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; confidence: number | null; probabilities: Record<string, number> }
  | { type: 'score'; score: number; confidence: number | null; probabilities: number[]; legend?: unknown };

export interface DecisionResult {
  answers: Record<string, DecisionAnswer>;
  /** The model that answered, when the body names one, else the configured name */
  model: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  /** The provider's request id, when it sent a plain one */
  requestId?: string;
  elapsedMs: number;
}

export type DecisionErrorCode = 'AUTH' | 'RATE_LIMITED' | 'TIMEOUT' | 'NETWORK' | 'MALFORMED' | 'ABORTED' | `HTTP_${number}`;

/** The model gave no usable answer. `code` is fixed; nothing the server sent is echoed. */
export class DecisionModelError extends Error {
  constructor(
    readonly code: DecisionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'DecisionModelError';
  }
}

export interface DecisionModelOptions {
  /** 'd1', 'jev' or 'endpoint': the name recorded with every verdict. */
  name: 'd1' | 'jev' | 'endpoint';
  /** Server root; `/v1/systemone` is appended. */
  baseURL: string;
  /** Model name sent and recorded. */
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Allow a non-loopback base URL (https). Default false. */
  allowRemote?: boolean;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** How the engine is told which model to use: a spec (`--decision-model`), or a built client. */
export interface DecisionModelConfig {
  /** 'd1', 'jev', an http(s) URL, or 'off'. */
  spec: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  allowRemote?: boolean;
}

function isUnit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function checkBaseURL(raw: string, allowRemote: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`decision model: "${raw}" is not a URL`);
  }
  if (url.username || url.password) throw new TypeError('decision model: the URL must not carry credentials');
  if (url.search || url.hash) throw new TypeError('decision model: the URL must not have a query or fragment');
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new TypeError('decision model: the URL must use https (http only for localhost, 127.0.0.1 and [::1])');
  }
  if (!loopback && !allowRemote) {
    throw new TypeError('decision model: a non-loopback URL needs allowRemote (--decision-model-allow-remote): the state carries transcript lines');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** The answer in a 2xx body, or null when it is outside the contract. */
export function parseDecisionBody(text: string): { answers: Record<string, DecisionAnswer>; model?: string; usage?: DecisionResult['usage'] } | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const raw = (body as { answers?: unknown } | null)?.answers;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const answers: Record<string, DecisionAnswer> = {};
  for (const [name, value] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
    if (!value || typeof value !== 'object') return null;
    if (value.type === 'noul') {
      if (!isUnit(value.noul)) return null;
      answers[name] = { type: 'noul', noul: value.noul };
    } else if (value.type === 'choice') {
      const probabilities = value.probabilities;
      if (typeof value.choice !== 'string' || !probabilities || typeof probabilities !== 'object' || Array.isArray(probabilities)) return null;
      if (!Object.values(probabilities as Record<string, unknown>).every(isUnit)) return null;
      if (value.confidence !== undefined && value.confidence !== null && !isUnit(value.confidence)) return null;
      answers[name] = { type: 'choice', choice: value.choice, confidence: isUnit(value.confidence) ? value.confidence : null, probabilities: probabilities as Record<string, number> };
    } else if (value.type === 'score') {
      if (typeof value.score !== 'number' || !Number.isFinite(value.score)) return null;
      const probabilities = Array.isArray(value.probabilities) && value.probabilities.every(isUnit) ? (value.probabilities as number[]) : null;
      if (!probabilities) return null;
      answers[name] = { type: 'score', score: value.score, confidence: isUnit(value.confidence) ? value.confidence : null, probabilities, ...(value.legend !== undefined ? { legend: value.legend } : {}) };
    } else {
      return null;
    }
  }
  const model = (body as { model?: unknown }).model;
  const usage = (body as { usage?: unknown }).usage;
  return {
    answers,
    ...(typeof model === 'string' && MODEL_NAME.test(model) ? { model } : {}),
    ...(usage && typeof usage === 'object' ? { usage: usage as DecisionResult['usage'] } : {}),
  };
}

export class DecisionModelClient {
  readonly name: 'd1' | 'jev' | 'endpoint';
  readonly baseURL: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly #apiKey: string | null;
  readonly #fetch: (input: string, init?: RequestInit) => Promise<Response>;

  constructor(options: DecisionModelOptions) {
    if (options.name !== 'd1' && options.name !== 'jev' && options.name !== 'endpoint') throw new TypeError('decision model: name is d1, jev or endpoint');
    this.name = options.name;
    this.baseURL = checkBaseURL(options.baseURL, options.allowRemote === true);
    const model = options.model ?? (options.name === 'jev' ? DEFAULT_JEV_MODEL : options.name === 'd1' ? DEFAULT_D1_MODEL : 'system-one');
    if (!MODEL_NAME.test(model)) throw new TypeError('decision model: the model name is letters, digits and ._:/@-');
    this.model = model;
    if (options.apiKey !== undefined) {
      if (typeof options.apiKey !== 'string' || !API_KEY.test(options.apiKey)) throw new TypeError('decision model: the API key is a non-empty printable ASCII string');
    } else if (options.name === 'jev') {
      throw new TypeError('decision model: jev needs an API key (TYPESAFE_API_KEY)');
    }
    this.#apiKey = options.apiKey ?? null;
    const timeout = options.timeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
    if (!(Number.isFinite(timeout) && timeout > 0 && timeout <= 2_147_483_647)) throw new TypeError('decision model: timeoutMs is a positive number of milliseconds');
    this.timeoutMs = timeout;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** Whether requests carry an Authorization header. */
  get authenticated(): boolean {
    return this.#apiKey !== null;
  }

  /**
   * Ask the model. Throws DecisionModelError (with a fixed code) on a
   * network error, a timeout, a non-2xx status or a body outside the
   * contract; the server's text is never passed on.
   */
  async decide(state: unknown, questions: Record<string, DecisionQuestion>, signal?: AbortSignal): Promise<DecisionResult> {
    if (signal?.aborted) throw new DecisionModelError('ABORTED', 'aborted before the request was sent');
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const forward = (): void => controller.abort();
    signal?.addEventListener('abort', forward, { once: true });
    const started = Date.now();
    try {
      let response: Response;
      try {
        response = await this.#fetch(`${this.baseURL}${SYSTEM_ONE_PATH}`, {
          method: 'POST',
          headers: {
            ...(this.#apiKey !== null ? { Authorization: `Bearer ${this.#apiKey}` } : {}),
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ model: this.model, state, questions }),
          redirect: 'error',
          signal: controller.signal,
        });
      } catch {
        throw new DecisionModelError(signal?.aborted ? 'ABORTED' : timedOut ? 'TIMEOUT' : 'NETWORK', `the decision model at ${this.baseURL} did not answer`);
      }
      const requestId = response.headers.get('x-typesafe-request-id') ?? response.headers.get('x-request-id');
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const code: DecisionErrorCode = response.status === 401 || response.status === 403 ? 'AUTH' : response.status === 429 ? 'RATE_LIMITED' : `HTTP_${response.status}`;
        throw new DecisionModelError(code, `the decision model at ${this.baseURL} answered ${response.status}`);
      }
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => {});
        throw new DecisionModelError('MALFORMED', 'the decision model answered with a body over 64 KiB');
      }
      let text: string;
      try {
        text = await response.text();
      } catch {
        throw new DecisionModelError(signal?.aborted ? 'ABORTED' : timedOut ? 'TIMEOUT' : 'NETWORK', 'the decision model stopped answering');
      }
      if (text.length > MAX_RESPONSE_BYTES) throw new DecisionModelError('MALFORMED', 'the decision model answered with a body over 64 KiB');
      const parsed = parseDecisionBody(text);
      if (!parsed) throw new DecisionModelError('MALFORMED', 'the decision model answered outside the contract');
      return {
        answers: parsed.answers,
        model: parsed.model ?? this.model,
        ...(parsed.usage ? { usage: parsed.usage } : {}),
        ...(requestId && /^[A-Za-z0-9._-]{1,128}$/.test(requestId) ? { requestId } : {}),
        elapsedMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forward);
    }
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, baseURL: this.baseURL, model: this.model, timeoutMs: this.timeoutMs, apiKey: this.#apiKey === null ? null : '[redacted]' };
  }
}

/**
 * The client a `--decision-model` spec names: `d1` (llama-server on
 * loopback, STENOGRAPHER_DECISION_MODEL_URL to move it), `jev` (TypeSafe,
 * TYPESAFE_API_KEY and TYPESAFE_BASE_URL), an http(s) URL (key from
 * STENOGRAPHER_DECISION_MODEL_KEY), or `off`/unset for none.
 */
export function decisionModelFromConfig(config: DecisionModelConfig | undefined, env: Record<string, string | undefined> = process.env): DecisionModelClient | null {
  const spec = config?.spec?.trim();
  if (!spec || spec === 'off' || spec === 'none') return null;
  const read = (name: string): string | undefined => env[name]?.trim() || undefined;
  const common = { ...(config!.timeoutMs !== undefined ? { timeoutMs: config!.timeoutMs } : {}), allowRemote: config!.allowRemote === true };
  if (spec === 'd1') {
    return new DecisionModelClient({ name: 'd1', baseURL: read('STENOGRAPHER_DECISION_MODEL_URL') ?? DEFAULT_D1_BASE_URL, model: config!.model ?? read('SMALLCHAT_D1_MODEL'), apiKey: config!.apiKey ?? read('STENOGRAPHER_DECISION_MODEL_KEY'), ...common });
  }
  if (spec === 'jev') {
    return new DecisionModelClient({ name: 'jev', baseURL: read('TYPESAFE_BASE_URL') ?? DEFAULT_JEV_BASE_URL, model: config!.model, apiKey: config!.apiKey ?? read('TYPESAFE_API_KEY'), allowRemote: true, ...(config!.timeoutMs !== undefined ? { timeoutMs: config!.timeoutMs } : {}) });
  }
  if (/^https?:\/\//.test(spec)) {
    return new DecisionModelClient({ name: 'endpoint', baseURL: spec, model: config!.model, apiKey: config!.apiKey ?? read('STENOGRAPHER_DECISION_MODEL_KEY'), ...common });
  }
  throw new TypeError(`--decision-model takes off, d1, jev or a System One endpoint URL, not "${spec}"`);
}
