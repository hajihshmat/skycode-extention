import { OllamaClient, parseOpenAiStreamChunk, parseSseFrame } from '../utils/ollamaHttpClient';
import { ChatMessageInput, ChatError, ChatRequestContext, ChatResponse, ChatStreamChunk, classifyHttpError, ProviderEntity, ResponseFormat, ResponseType } from '../types';
import { joinUrl } from '../modelService';
import { ModelDraft, ProviderAdapter } from './providerAdapter';

/**
 * OpenAI adapter — the chat/completions wire format is identical to the
 * OpenAI-compatible client, so it reuses it. Works for api.openai.com and
 * any OpenAI-compatible base URL.
 */
export class OpenAIAdapter implements ProviderAdapter {
	// Typed as string so subclasses (e.g. OpenAICompatibleAdapter) can override the identity.
	readonly type: string = 'openai';
	readonly displayName: string = 'OpenAI';
	readonly requiresCredentials = true;
	readonly supportedResponseTypes: ResponseType[] = ['chat-completion', 'response'];
	readonly supportedResponseFormats: ResponseFormat[] = ['text', 'json_object'];

	resolveEndpoints(provider: ProviderEntity): { chat: string; models: string; show?: string } {
		const base = provider.baseUrl.replace(/\/+$/, '');
		const hasV1 = /\/v1$/.test(base);
		return {
			chat: joinUrl(base, provider.chatEndpoint ?? (hasV1 ? '/chat/completions' : '/v1/chat/completions')),
			models: provider.modelsUrl ?? joinUrl(base, hasV1 ? '/models' : '/v1/models')
		};
	}

	private client(baseUrl: string, apiKey?: string): OllamaClient {
		return new OllamaClient({ baseUrl, apiKey, timeoutMs: 30_000 });
	}

	async discoverModels(provider: ProviderEntity, apiKey?: string): Promise<ModelDraft[]> {
		const { models } = this.resolveEndpoints(provider);
		const client = this.client(stripSuffix(models, '/models'), apiKey);
		const ids = await client.listModels();
		return ids.map(id => ({ modelIdentifier: id, name: id }));
	}

	async sendChat(ctx: ChatRequestContext): Promise<ChatResponse> {
		const client = this.client(stripSuffix(ctx.endpoint, '/chat/completions'), ctx.apiKey);
		const { content, raw } = await client.chat({
			model: ctx.model,
			messages: ctx.messages,
			// Chat Completions uses `response_format: { type: 'json_object' }`.
			...(ctx.responseFormat === 'json_object' && { response_format: { type: 'json_object' } }),
			...ctx.options
		});
		return { text: content, raw };
	}

	async *sendChatStream(ctx: ChatRequestContext): AsyncIterable<ChatStreamChunk> {
		const client = this.client(stripSuffix(ctx.endpoint, '/chat/completions'), ctx.apiKey);
		for await (const payload of client.chatStream({
			model: ctx.model,
			messages: ctx.messages,
			...(ctx.responseFormat === 'json_object' && { response_format: { type: 'json_object' } }),
			...ctx.options
		}, ctx.signal)) {
			yield parseOpenAiStreamChunk(payload);
		}
	}

	/**
	 * OpenAI Responses API (POST {base}/responses). Differences from chat
	 * completions that stay encapsulated here:
	 *  - system prompt goes to the top-level `instructions` field
	 *  - input is `[{ role, content: [{ type: 'input_text', text }] }]`
	 *  - output is `output[]` items with `content[]` `output_text` blocks
	 *  - usage uses input_tokens/output_tokens
	 */
	async sendResponse(ctx: ChatRequestContext): Promise<ChatResponse> {
		const base = deriveApiBase(ctx.endpoint);
		const url = `${base}/responses`;
		const { system, messages } = splitSystemMessages(ctx.messages);
		const body: Record<string, unknown> = {
			model: ctx.model,
			input: messages.map(m => ({
				role: m.role,
				content: [{ type: 'input_text', text: m.content }]
			})),
			...(system && { instructions: system }),
			...(ctx.options?.temperature !== undefined && { temperature: ctx.options.temperature }),
			...(ctx.options?.max_tokens !== undefined && { max_output_tokens: ctx.options.max_tokens }),
			// Responses API uses a nested `text.format` shape instead of `response_format`.
			...(ctx.responseFormat === 'json_object' && { text: { format: { type: 'json_object' } } })
		};

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(ctx.apiKey && { authorization: `Bearer ${ctx.apiKey}` })
			},
			body: JSON.stringify(body)
		});
		this.checkStatus(response);
		const json = (await response.json()) as {
			output?: { type?: string; content?: { type?: string; text?: string }[] }[];
			usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
		};
		const text = (json.output ?? [])
			.flatMap(item => (item.type === 'message' ? item.content ?? [] : []))
			.filter(block => block.type === 'output_text')
			.map(block => block.text ?? '')
			.join('');
		const promptTokens = json.usage?.input_tokens;
		const completionTokens = json.usage?.output_tokens;
		return {
			text,
			usage: {
				promptTokens,
				completionTokens,
				totalTokens: json.usage?.total_tokens ?? (((promptTokens ?? 0) + (completionTokens ?? 0)) || undefined)
			},
			raw: json
		};
	}

	/**
	 * Streaming variant of sendResponse (SSE). Responses API events handled:
	 *  - response.created            → stream opened
	 *  - response.output_text.delta  → { delta } text chunk
	 *  - response.output_text.done   → end of one output item (ignored)
	 *  - response.completed          → { response.usage } + done
	 *  - error / response.failed     → throws (surfaced to the caller)
	 */
	async *sendResponseStream(ctx: ChatRequestContext): AsyncIterable<ChatStreamChunk> {
		const base = deriveApiBase(ctx.endpoint);
		const { system, messages } = splitSystemMessages(ctx.messages);
		const body: Record<string, unknown> = {
			model: ctx.model,
			input: messages.map(m => ({
				role: m.role,
				content: [{ type: 'input_text', text: m.content }]
			})),
			...(system && { instructions: system }),
			...(ctx.options?.temperature !== undefined && { temperature: ctx.options.temperature }),
			...(ctx.options?.max_tokens !== undefined && { max_output_tokens: ctx.options.max_tokens }),
			...(ctx.responseFormat === 'json_object' && { text: { format: { type: 'json_object' } } }),
			stream: true
		};

		const response = await fetch(`${base}/responses`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'text/event-stream',
				...(ctx.apiKey && { authorization: `Bearer ${ctx.apiKey}` })
			},
			body: JSON.stringify(body),
			signal: ctx.signal
		});
		this.checkStatus(response);
		if (!response.body) {
			throw new ChatError('network', 'Empty response body from OpenAI Responses API');
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

				let separatorIndex: number;
				while ((separatorIndex = buffer.indexOf('\n\n')) !== -1) {
					const frame = buffer.slice(0, separatorIndex);
					buffer = buffer.slice(separatorIndex + 2);
					const payload = parseSseFrame(frame);
					if (!payload) {
						continue;
					}
					const event = parseResponsesSseEvent(payload);
					if (!event) {
						continue;
					}
					switch (event.type) {
						case 'response.output_text.delta': {
							if (event.delta) {
								yield { content: event.delta };
							}
							break;
						}
						case 'response.completed': {
							const usage = event.response?.usage;
							yield {
								content: '',
								done: true,
								usage: usage
									? {
										promptTokens: usage.input_tokens,
										completionTokens: usage.output_tokens,
										totalTokens: usage.total_tokens
									}
									: undefined
							};
							return;
						}
						case 'error':
						case 'response.failed': {
							throw new ChatError('server', event.message ?? 'OpenAI Responses stream error');
						}
					}
				}
			}
			// Stream ended without response.completed — treat as complete.
			yield { content: '', done: true };
		} finally {
			reader.releaseLock();
		}
	}

	private checkStatus(response: Response): void {
		if (response.ok) {
			return;
		}
		let message = `OpenAI request failed with HTTP ${response.status}`;
		if (response.status === 401 || response.status === 403) {
			message = `Authentication failed (HTTP ${response.status}). Check your API key.`;
		} else if (response.status === 429) {
			message = 'Rate limit exceeded (HTTP 429).';
		}
		const retryAfter = response.headers.get('retry-after');
		const error = classifyHttpError(response.status, message);
		if (error.kind === 'rate-limited' && retryAfter) {
			error.retryAfterSec = Number(retryAfter) || undefined;
		}
		throw error;
	}

	async testConnection(provider: ProviderEntity, apiKey?: string): Promise<void> {
		const { models } = this.resolveEndpoints(provider);
		await this.client(stripSuffix(models, '/models'), apiKey).listModels();
	}
}

function stripSuffix(url: string, suffix: string): string {
	return url.endsWith(suffix) ? url.slice(0, -suffix.length) : url;
}

/**
 * Derive the API base from a chat-completions endpoint so the Responses URL
 * stays override-aware: https://api.openai.com/v1/chat/completions →
 * https://api.openai.com/v1 (any absolute base works, incl. overrides).
 */
function deriveApiBase(endpoint: string): string {
	return endpoint.replace(/\/chat\/completions.*$/, '').replace(/\/responses.*$/, '').replace(/\/+$/, '');
}

/** Responses API takes the system prompt via `instructions`, not a message role. */
function splitSystemMessages(messages: ChatMessageInput[]): { system?: string; messages: ChatMessageInput[] } {
	const system = messages
		.filter(m => m.role === 'system')
		.map(m => m.content)
		.join('\n');
	return {
		system: system || undefined,
		messages: messages.filter(m => m.role !== 'system')
	};
}

/**
 * Subset of Responses API SSE event payloads we care about. The `type` field
 * is the event discriminator; other fields vary per event type.
 */
interface ResponsesSseEvent {
	type: string;
	/** response.output_text.delta */
	delta?: string;
	/** response.completed */
	response?: {
		usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
	};
	/** error / response.failed */
	message?: string;
	code?: string;
}

/** Parse one Responses API SSE payload into a typed event; undefined if not usable. */
function parseResponsesSseEvent(payload: { data: string; done: boolean }): ResponsesSseEvent | undefined {
	if (payload.done || !payload.data || payload.data === '[DONE]') {
		return undefined;
	}
	return JSON.parse(payload.data) as ResponsesSseEvent;
}
