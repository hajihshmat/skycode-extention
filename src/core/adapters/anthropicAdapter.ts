import {
	ChatMessageInput,
	ChatRequestContext,
	ChatResponse,
	ChatStreamChunk,
	ChatError,
	classifyHttpError,
	ResponseFormat,
	ResponseType,
	ModelEntity,
	ProviderEntity
} from '../types';
import { joinUrl } from '../modelService';
import { ModelDraft, ProviderAdapter } from './providerAdapter';

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Anthropic adapter (Messages API). Differences from OpenAI-style APIs that
 * stay encapsulated here:
 *  - auth via `x-api-key` header (not Bearer)
 *  - `system` is a top-level field, not a message role
 *  - `max_tokens` is required
 *  - response is a content-block list
 */
export class AnthropicAdapter implements ProviderAdapter {
	readonly type = 'anthropic';
	readonly displayName = 'Anthropic';
	readonly requiresCredentials = true;
	readonly supportedResponseTypes: ResponseType[] = ['chat-completion'];
	readonly supportedResponseFormats: ResponseFormat[] = ['text'];

	resolveEndpoints(provider: ProviderEntity): { chat: string; models: string; show?: string } {
		const base = provider.baseUrl.replace(/\/+$/, '');
		const hasV1 = /\/v1$/.test(base);
		return {
			chat: joinUrl(base, provider.chatEndpoint ?? (hasV1 ? '/messages' : '/v1/messages')),
			models: provider.modelsUrl ?? joinUrl(base, hasV1 ? '/models' : '/v1/models')
		};
	}

	private headers(apiKey?: string): Record<string, string> {
		return {
			'content-type': 'application/json',
			'x-api-key': apiKey ?? '',
			'anthropic-version': ANTHROPIC_VERSION
		};
	}

	async discoverModels(provider: ProviderEntity, apiKey?: string): Promise<ModelDraft[]> {
		const { models } = this.resolveEndpoints(provider);
		const response = await fetch(models, { method: 'GET', headers: this.headers(apiKey) });
		this.checkStatus(response);
		const json = (await response.json()) as { data?: { id?: string }[] };
		return (json.data ?? [])
			.map(m => m.id)
			.filter((id): id is string => typeof id === 'string')
			.map(id => ({ modelIdentifier: id, name: id }));
	}

	async sendChat(ctx: ChatRequestContext): Promise<ChatResponse> {
		const { system, messages } = splitSystem(ctx.messages);
		const maxTokens = (ctx.options?.max_tokens as number) ?? DEFAULT_MAX_TOKENS;
		const body: Record<string, unknown> = {
			model: ctx.model,
			max_tokens: maxTokens,
			messages: messages.map(m => ({ role: m.role, content: m.content })),
			...(system && { system }),
			...(ctx.options?.temperature !== undefined && { temperature: ctx.options.temperature })
		};

		const response = await fetch(ctx.endpoint, {
			method: 'POST',
			headers: this.headers(ctx.apiKey),
			body: JSON.stringify(body)
		});
		this.checkStatus(response);
		const json = (await response.json()) as {
			content?: { type: string; text?: string }[];
			usage?: { input_tokens?: number; output_tokens?: number };
		};
		const text = (json.content ?? [])
			.filter(b => b.type === 'text')
			.map(b => b.text ?? '')
			.join('');
		const promptTokens = json.usage?.input_tokens;
		const completionTokens = json.usage?.output_tokens;
		return {
			text,
			usage: {
				promptTokens,
				completionTokens,
				totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0) || undefined
			},
			raw: json
		};
	}

	async testConnection(provider: ProviderEntity, apiKey?: string): Promise<void> {
		await this.discoverModels(provider, apiKey);
	}

	/**
	 * Anthropic Messages API streaming (SSE). Event shapes handled:
	 *  - message_start        → usage.input_tokens
	 *  - content_block_delta  → delta.text (type: 'text_delta')
	 *  - message_delta        → usage.output_tokens / stop_reason
	 *  - message_stop         → end of stream
	 *  - error                → throws (surfaced to the caller)
	 */
	async *sendChatStream(ctx: ChatRequestContext): AsyncIterable<ChatStreamChunk> {
		const { system, messages } = splitSystem(ctx.messages);
		const maxTokens = (ctx.options?.max_tokens as number) ?? DEFAULT_MAX_TOKENS;
		const body: Record<string, unknown> = {
			model: ctx.model,
			max_tokens: maxTokens,
			messages: messages.map(m => ({ role: m.role, content: m.content })),
			...(system && { system }),
			...(ctx.options?.temperature !== undefined && { temperature: ctx.options.temperature }),
			stream: true
		};

		const response = await fetch(ctx.endpoint, {
			method: 'POST',
			headers: { ...this.headers(ctx.apiKey), accept: 'text/event-stream' },
			body: JSON.stringify(body)
		});
		this.checkStatus(response);
		if (!response.body) {
			throw new ChatError('network', 'Empty response body from Anthropic');
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let usage: ChatStreamChunk['usage'] | undefined;

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
					const event = parseAnthropicSseEvent(frame);
					if (!event) {
						continue;
					}
					switch (event.type) {
						case 'content_block_delta': {
							const delta = (event as { delta?: { type?: string; text?: string } }).delta;
							if (delta?.type === 'text_delta' && delta.text) {
								yield { content: delta.text };
							}
							break;
						}
						case 'message_start': {
							const inputTokens = (event as {
								message?: { usage?: { input_tokens?: number } };
							}).message?.usage?.input_tokens;
							if (inputTokens !== undefined) {
								usage = { ...usage, promptTokens: inputTokens };
							}
							break;
						}
						case 'message_delta': {
							const ev = event as {
								delta?: { stop_reason?: string | null };
								usage?: { output_tokens?: number };
							};
							if (ev.usage?.output_tokens !== undefined) {
								usage = { ...usage, completionTokens: ev.usage.output_tokens };
							}
							break;
						}
						case 'message_stop': {
							yield { content: '', done: true, usage };
							return;
						}
						case 'error': {
							const message = (event as { error?: { message?: string } }).error?.message;
							throw new ChatError('server', message ?? 'Anthropic stream error');
						}
					}
				}
			}
			// Stream ended without an explicit message_stop — treat as complete.
			yield { content: '', done: true, usage };
		} finally {
			reader.releaseLock();
		}
	}

	private checkStatus(response: Response): void {
		if (response.ok) {
			return;
		}
		let message = `Anthropic request failed with HTTP ${response.status}`;
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
}

/** Anthropic takes `system` as a top-level field, not a message role. */
export function splitSystem(messages: ChatMessageInput[]): { system?: string; messages: ChatMessageInput[] } {
	const system = messages
		.filter(m => m.role === 'system')
		.map(m => m.content)
		.join('\n');
	return {
		system: system || undefined,
		messages: messages.filter(m => m.role !== 'system')
	};
}

interface AnthropicSseEvent {
	type: string;
	[key: string]: unknown;
}

/** Parse one Anthropic SSE frame (`event:`/`data:` lines) into its JSON payload. */
function parseAnthropicSseEvent(frame: string): AnthropicSseEvent | undefined {
	const dataLines = frame
		.split('\n')
		.filter(line => line.startsWith('data:'))
		.map(line => line.slice(5).trim());
	if (dataLines.length === 0) {
		return undefined;
	}
	const data = dataLines.join('\n');
	if (!data || data === '[DONE]') {
		return undefined;
	}
	return JSON.parse(data) as AnthropicSseEvent;
}
