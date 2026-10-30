import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

export type VisionImage = { media_type: 'image/jpeg' | 'image/png' | 'image/webp'; data: string };

export class ScannerBusyError extends Error {}
export class ScannerUnavailableError extends Error {}
export class ScannerUnreadableError extends Error {}

// Free Groq vision model by default; GROQ_VISION_MODEL overrides it when Groq retires or renames models.
const DEFAULT_GROQ_MODEL = 'qwen/qwen3.8-27b';

/** Anthropic is used when ANTHROPIC_API_KEY is set (best accuracy); otherwise Groq (free tier) when GROQ_API_KEY is set. */
function provider(): 'anthropic' | 'groq' | null {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.GROQ_API_KEY) return 'groq';
  return null;
}

export function scannerIsConfigured(): boolean {
  return provider() !== null;
}

type ExtractOptions<T extends z.ZodType> = {
  system: string;
  images: VisionImage[];
  instruction: string;
  schema: T;
  maxTokens: number;
  label: string;
};

/** Reads the photos and returns data matching the schema. `truncated` is true when the model ran out of room. */
export async function extractFromImages<T extends z.ZodType>(options: ExtractOptions<T>): Promise<{ data: z.infer<T>; truncated: boolean }> {
  const which = provider();
  if (which === 'anthropic') return extractWithAnthropic(options);
  if (which === 'groq') return extractWithGroq(options);
  throw new ScannerUnavailableError('Receipt scanning is not set up');
}

async function extractWithAnthropic<T extends z.ZodType>({ system, images, instruction, schema, maxTokens, label }: ExtractOptions<T>) {
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.parse({
      model: 'claude-opus-5-5',
      max_tokens: maxTokens,
      system,
      messages: [{
        role: 'user',
        content: [
          ...images.map(image => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: image.media_type, data: image.data } })),
          { type: 'text' as const, text: instruction },
        ],
      }],
      output_config: { effort: 'low', format: zodOutputFormat(schema) },
    });
    if (response.stop_reason === 'refusal' || !response.parsed_output) throw new ScannerUnreadableError('No readable result');
    return { data: response.parsed_output as z.infer<T>, truncated: response.stop_reason === 'max_tokens' };
  } catch (error) {
    if (error instanceof ScannerUnreadableError) throw error;
    if (error instanceof Anthropic.RateLimitError) throw new ScannerBusyError('Anthropic rate limit');
    if (error instanceof Anthropic.APIError) {
      console.error(`${label} failed`, error.status, error.message);
      throw new ScannerUnavailableError('Anthropic request failed');
    }
    throw error;
  }
}

type GroqResponse = { choices?: { message?: { content?: string | null }; finish_reason?: string }[]; error?: { message?: string; code?: string } };

// Strips a ```json fence if the model added one, then parses.
function parseJson(text: string): unknown {
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(body);
}

async function extractWithGroq<T extends z.ZodType>({ system, images, instruction, schema, maxTokens, label }: ExtractOptions<T>) {
  const jsonShape = JSON.stringify(z.toJSONSchema(schema));
  const systemPrompt = `${system}\n\nReply with one JSON object only (no prose, no code fence) that follows this JSON Schema exactly:\n${jsonShape}`;
  const body = {
    model: process.env.GROQ_VISION_MODEL?.trim() || DEFAULT_GROQ_MODEL,
    max_tokens: Math.min(maxTokens, 8000),
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          ...images.map(image => ({ type: 'image_url', image_url: { url: `data:${image.media_type};base64,${image.data}` } })),
          { type: 'text', text: `${instruction}\nAnswer in JSON.` },
        ],
      },
    ],
  };

  let response: Response;
  try {
    response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(50_000),
    });
  } catch (error) {
    console.error(`${label} (groq) network error`, error instanceof Error ? error.message : error);
    throw new ScannerUnavailableError('Groq request failed');
  }

  const payload = (await response.json().catch(() => null)) as GroqResponse | null;
  if (!response.ok) {
    if (response.status === 429) throw new ScannerBusyError('Groq rate limit');
    if (payload?.error?.code === 'json_validate_failed') throw new ScannerUnreadableError('Model did not return valid JSON');
    console.error(`${label} (groq) failed`, response.status, payload?.error?.message);
    throw new ScannerUnavailableError('Groq request failed');
  }

  const choice = payload?.choices?.[0];
  const content = choice?.message?.content;
  if (!content) throw new ScannerUnreadableError('Empty answer');
  let parsedJson: unknown;
  try {
    parsedJson = parseJson(content);
  } catch {
    throw new ScannerUnreadableError('Answer was not JSON');
  }
  const checked = schema.safeParse(parsedJson);
  if (!checked.success) throw new ScannerUnreadableError('Answer did not match the expected shape');
  return { data: checked.data as z.infer<T>, truncated: choice?.finish_reason === 'length' };
}
