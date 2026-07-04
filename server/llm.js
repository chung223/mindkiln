import Anthropic from '@anthropic-ai/sdk';
import { readConfig } from './store.js';

export const DEFAULT_MODEL = 'claude-opus-4-8';
export const DEFAULT_OPENAI_BASE_URL = 'http://localhost:11434/v1'; // Ollama 預設
export const DEFAULT_COMPAT_BASE_URL = 'https://api.minimaxi.com/anthropic'; // MiniMax Anthropic 相容端點
export const DEFAULT_COMPAT_MODEL = 'MiniMax-M3';

export function getProvider() {
  const p = readConfig().provider;
  if (p === 'openai') return 'openai';
  if (p === 'compat') return 'compat'; // Anthropic 相容端點(MiniMax 等)
  return 'anthropic';
}

export function getModel() {
  const cfg = readConfig();
  const p = getProvider();
  if (p === 'openai') return cfg.openaiModel || 'llama3.1';
  if (p === 'compat') return cfg.compatModel || DEFAULT_COMPAT_MODEL;
  return cfg.model || DEFAULT_MODEL;
}

// 只有這些 Anthropic 模型支援 adaptive thinking;其餘(含所有本地模型)須省略 thinking 參數
const ADAPTIVE_THINKING_MODELS = /^claude-(opus-4-[678]|sonnet-(4-6|5)|fable-5)/;
export function thinkingFor(model) {
  return ADAPTIVE_THINKING_MODELS.test(model) ? { thinking: { type: 'adaptive' } } : {};
}

export function describeError(err) {
  if (err?.name === 'AbortError') return '請求已取消。';
  if (/Could not resolve authentication method/i.test(err?.message || '')) {
    return '尚未設定 API 憑證。請點左下角「設定」填入 Anthropic API 金鑰,或改用本地模型。';
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(err?.message || '')) {
    return '無法連線到本地模型伺服器。請確認 Ollama / LM Studio 等已啟動,且「設定」中的 Base URL 正確。';
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return '認證失敗:API 金鑰無效或未設定。請到「設定」填入 Anthropic API 金鑰,或先執行 `ant auth login`。';
  }
  if (err instanceof Anthropic.RateLimitError) {
    return '已達速率限制,請稍後再試。';
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return '無法連線到 Anthropic API,請檢查網路。';
  }
  if (err instanceof Anthropic.APIError) {
    return `API 錯誤(${err.status}):${err.message}`;
  }
  return err?.message || String(err);
}

/**
 * 統一的串流生成介面,依 provider 分派。
 * @returns {Promise<{ text, usage, stopReason, truncated }>}
 *   stopReason: 'end_turn' | 'max_tokens' | ...;refusal 會直接 throw。
 *   text 為未加截斷提示的原始文字;truncated 為 true 表示達到長度上限。
 */
export async function streamChat({ system, messages, maxTokens = 16000, onDelta, signal, model }) {
  const cfg = readConfig();
  const provider = getProvider();
  if (provider === 'openai') {
    return streamOpenAICompatible({ cfg, system, messages, maxTokens, onDelta, signal, modelOverride: model });
  }
  return streamAnthropic({ cfg, provider, system, messages, maxTokens, onDelta, signal, modelOverride: model });
}

// 各 provider 的預設模型;供分模型層級(維度用便宜模型)取用
export function providerModels() {
  const cfg = readConfig();
  const p = getProvider();
  if (p === 'openai') return { current: cfg.openaiModel || 'llama3.1' };
  if (p === 'compat') return { current: cfg.compatModel || DEFAULT_COMPAT_MODEL };
  return { current: cfg.model || DEFAULT_MODEL };
}

// ---------- Anthropic 及 Anthropic 相容端點(MiniMax 等) ----------

async function streamAnthropic({ cfg, provider, system, messages, maxTokens, onDelta, signal, modelOverride }) {
  let client;
  let model;
  if (provider === 'compat') {
    // MiniMax 等:走 Anthropic Messages API 相容端點,只換 baseURL + 金鑰 + 模型名
    client = new Anthropic({
      apiKey: cfg.compatApiKey || 'unused',
      baseURL: cfg.compatBaseURL || DEFAULT_COMPAT_BASE_URL,
    });
    model = modelOverride || cfg.compatModel || DEFAULT_COMPAT_MODEL;
  } else {
    client = cfg.apiKey ? new Anthropic({ apiKey: cfg.apiKey }) : new Anthropic();
    model = modelOverride || cfg.model || DEFAULT_MODEL;
  }
  const stream = client.messages.stream({
    model,
    max_tokens: maxTokens,
    ...thinkingFor(model),
    system,
    messages,
  });
  if (signal) {
    if (signal.aborted) stream.abort();
    else signal.addEventListener('abort', () => stream.abort(), { once: true });
  }
  if (onDelta) stream.on('text', (d) => onDelta(d));

  const final = await stream.finalMessage();
  if (final.stop_reason === 'refusal') {
    throw new Error('模型基於安全原因拒絕了此請求。');
  }
  const text = final.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return {
    text,
    usage: {
      input: final.usage.input_tokens,
      output: final.usage.output_tokens,
      cacheRead: final.usage.cache_read_input_tokens,
      cacheWrite: final.usage.cache_creation_input_tokens,
    },
    stopReason: final.stop_reason,
    truncated: final.stop_reason === 'max_tokens',
  };
}

// ---------- OpenAI 相容(Ollama / LM Studio / llama.cpp / vLLM …) ----------

// 把 Anthropic 風格的 system(可能是 blocks 陣列)與 messages(content 可能是 blocks)
// 攤平成 OpenAI Chat Completions 格式
function toOpenAIMessages(system, messages) {
  const flat = (content) =>
    Array.isArray(content) ? content.map((b) => b.text || '').join('') : String(content ?? '');
  const systemText = Array.isArray(system) ? system.map((b) => b.text || '').join('\n\n') : system || '';
  const out = [];
  if (systemText) out.push({ role: 'system', content: systemText });
  // 合併相鄰同角色訊息:議事會等情境會產生連續 user 回合,部分 OpenAI 相容伺服器會拒絕
  for (const m of messages) {
    const text = flat(m.content);
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${text}`;
    else out.push({ role: m.role, content: text });
  }
  return out;
}

async function streamOpenAICompatible({ cfg, system, messages, maxTokens, onDelta, signal, modelOverride }) {
  const baseURL = (cfg.openaiBaseURL || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
  const model = modelOverride || cfg.openaiModel || 'llama3.1';
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.openaiApiKey) headers.Authorization = `Bearer ${cfg.openaiApiKey}`;

  const res = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model,
      messages: toOpenAIMessages(system, messages),
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true }, // 部分伺服器忽略此欄,無妨
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`本地模型回傳錯誤(${res.status}):${errText.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let finishReason = 'stop';
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      if (json.usage) usage = json.usage;
      const choice = json.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta?.content;
      if (delta) {
        text += delta;
        if (onDelta) onDelta(delta);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }

  if (finishReason === 'content_filter') {
    throw new Error('本地模型基於內容過濾拒絕了此請求。');
  }
  const truncated = finishReason === 'length';
  return {
    text,
    usage: usage
      ? { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0, cacheRead: 0, cacheWrite: 0 }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: truncated ? 'max_tokens' : 'end_turn',
    truncated,
  };
}
