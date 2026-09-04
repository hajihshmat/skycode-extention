/**
 * Minimal HTTP client for the Ollama Cloud API (OpenAI-compatible endpoints).
 * Kept separate from the provider so it stays small and testable.
 */

export interface OllamaClientOptions {
	baseUrl: string;
	apiKey?: string;
	timeoutMs: number;
}

export interface ChatRequestBody {
	model: string;
	messages: { role: string; content: string }[];
	stream?: boolean;
	temperature?: number;
	max_tokens?: number;
	stop?: string[];
	[key: string]: unknown;
}

import { ChatStreamUsage, classifyHttpError } from '../types';

/** An SSE "data:" payload parsed from a streaming response. */
export interface SsePayload {
	data: string;
	done: boolean;
}

export class OllamaClient {
	private options: OllamaClientOptions;

	constructor(options: OllamaClientOptions) {
		this.options = options;
	}

	updateOptions(partial: Partial<OllamaClientOptions>): void {
		this.options = { ...this.options, ...partial };
	}

	private headers(): Record<string, string> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json'
		};
		if (this.options.apiKey) {
			headers['Authorization'] = `Bearer ${this.options.apiKey}`;
		}
		return headers;
	}

	private async fetchWithTimeout(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
		const abort = () => controller.abort();
		if (signal?.aborted) {
			abort();
		}
		signal?.addEventListener('abort', abort, { once: true });
		try {
			return await fetch(url, { ...init, signal: controller.signal });
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener('abort', abort);
		}
	}

	private handleStatus(response: Response): void {
		if (response.ok) {
			return;
		}
		const status = response.status;
		const message =
			status === 401 || status === 403
				? `Authentication failed (HTTP ${status}). Check your API key.`
				: status === 404
					? `Endpoint or model not found (HTTP 404) at ${this.options.baseUrl}`
					: status === 429
						? 'Rate limit exceeded (HTTP 429).'
						: `Request failed with HTTP ${status}`;
		throw classifyHttpError(status, message);
	}

	/** GET {baseUrl}/models — returns available model ids. */
	async listModels(): Promise<string[]> {
		const response = await this.fetchWithTimeout(`${this.options.baseUrl}/models`, {
			method: 'GET',
			headers: this.headers()
		});
		this.handleStatus(response);
		const body = (await response.json()) as { data?: { id?: string }[] };
		return (body.data ?? [])
			.map(m => m.id)
			.filter((id): id is string => typeof id === 'string');
	}

	/** POST {baseUrl}/chat/completions (non-streaming). */
	async chat(body: ChatRequestBody): Promise<{ content: string; raw: unknown }> {
		const response = await this.fetchWithTimeout(`${this.options.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify({ ...body, stream: false })
		});
		this.handleStatus(response);
		const json = (await response.json()) as {
			choices?: { message?: { content?: string } }[];
		};
		const content = json.choices?.[0]?.message?.content ?? '';
		return { content, raw: json };
	}

	/**
	 * POST {showUrl} — Ollama's native /api/show endpoint for model details
	 * (context length, capabilities, size). showUrl is the absolute endpoint,
	 * e.g. http://localhost:11434/api/show.
	 */
	async showModel(model: string, showUrl: string): Promise<OllamaModelInfo> {
		const response = await this.fetchWithTimeout(showUrl, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify({ model })
		});
		this.handleStatus(response);
		const json = await response.json();
		return parseOllamaShowResponse(json);
	}

	/** POST {baseUrl}/chat/completions with stream:true; yields SSE data payloads. */
	async *chatStream(body: ChatRequestBody, signal?: AbortSignal): AsyncGenerator<SsePayload> {
		const response = await this.fetchWithTimeout(`${this.options.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify({ ...body, stream: true })
		}, signal);
		this.handleStatus(response);

		if (!response.body) {
			throw new Error('Empty response body from Ollama Cloud');
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });

				// SSE frames are separated by a blank line.
				let separatorIndex: number;
				while ((separatorIndex = buffer.indexOf('\n\n')) !== -1) {
					const frame = buffer.slice(0, separatorIndex);
					buffer = buffer.slice(separatorIndex + 2);
					const payload = parseSseFrame(frame);
					if (payload) {
						yield payload;
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}
}

/** Parsed subset of the Ollama /api/show response we care about. */
export interface OllamaModelInfo {
	contextLength?: number;
	supportsVision?: boolean;
	supportsTools?: boolean;
	parameterSize?: string;
	quantizationLevel?: string;
}

 
export function parseOllamaShowResponse(json: any): OllamaModelInfo {
	 
	const info = json?.model_info ?? {};
	const contextLengths = Object.entries(info)
		.filter(([key]) => key.endsWith('.context_length'))
		.map(([, value]) => Number(value) || 0);
	const capabilities: string[] = Array.isArray(json?.capabilities) ? json.capabilities : [];
	return {
		contextLength: contextLengths.length > 0 ? Math.max(...contextLengths) : undefined,
		supportsVision: capabilities.includes('vision'),
		supportsTools: capabilities.includes('tools'),
		parameterSize: json?.details?.parameter_size,
		quantizationLevel: json?.details?.quantization_level
	};
}

/** Parse one SSE frame; returns null for comments/keep-alives. */
export function parseSseFrame(frame: string): SsePayload | null {
	const dataLines = frame
		.split('\n')
		.filter(line => line.startsWith('data:'))
		.map(line => line.slice(5).trim());

	if (dataLines.length === 0) {
		return null;
	}
	const data = dataLines.join('\n');
	if (data === '[DONE]') {
		return { data: '', done: true };
	}
	return { data, done: false };
}

/** Shape of an OpenAI-compatible streaming chunk (also used by Ollama). */
interface OpenAiStreamChunkJson {
	choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
	usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** Parse one OpenAI-style SSE payload into a stream chunk. Throws on invalid JSON. */
export function parseOpenAiStreamChunk(payload: SsePayload): {
	content: string;
	done: boolean;
	usage?: ChatStreamUsage;
} {
	if (payload.done) {
		return { content: '', done: true };
	}
	const json = JSON.parse(payload.data) as OpenAiStreamChunkJson;
	const content = json.choices?.[0]?.delta?.content ?? '';
	const finished = json.choices?.[0]?.finish_reason !== null && json.choices?.[0]?.finish_reason !== undefined;
	const usage: ChatStreamUsage | undefined = json.usage
		? {
			promptTokens: json.usage.prompt_tokens,
			completionTokens: json.usage.completion_tokens,
			totalTokens: json.usage.total_tokens
		}
		: undefined;
	return { content, done: finished, usage };
}
