import { OllamaClient, OllamaModelInfo, parseOpenAiStreamChunk } from '../utils/ollamaHttpClient';
import { ChatRequestContext, ChatResponse, ChatStreamChunk, ModelEntity, ProviderEntity, ResponseFormat, ResponseType } from '../types';
import { joinUrl } from '../modelService';
import { AdapterEndpointDefaults, ModelDraft, ProviderAdapter } from './providerAdapter';

/**
 * Ollama adapter. All Ollama specifics (endpoint shapes, /api/show parsing)
 * live here — nothing above this layer knows about Ollama.
 *
 * Endpoint defaults adapt to both shapes users configure:
 *   http://localhost:11434        → /v1/chat/completions, /v1/models
 *   https://ollama.com/v1         → /chat/completions,  /models
 */
export class OllamaAdapter implements ProviderAdapter {
	readonly type = 'ollama';
	readonly displayName = 'Ollama';
	readonly requiresCredentials = false;
	readonly supportedResponseTypes: ResponseType[] = ['chat-completion'];
	readonly supportedResponseFormats: ResponseFormat[] = ['text', 'json_object'];

	private readonly defaults: AdapterEndpointDefaults = {
		chatEndpoint: '/chat/completions',
		modelsEndpoint: '/models',
		showEndpoint: '/api/show'
	};

	resolveEndpoints(provider: ProviderEntity): { chat: string; models: string; show?: string } {
		const base = provider.baseUrl.replace(/\/+$/, '');
		const hasV1 = /\/v1$/.test(base);
		const chat = joinUrl(base, provider.chatEndpoint ?? (hasV1 ? '/chat/completions' : '/v1/chat/completions'));
		const models = provider.modelsUrl ?? joinUrl(base, hasV1 ? '/models' : '/v1/models');
		const show = joinUrl(base.replace(/\/v1$/, ''), this.defaults.showEndpoint!);
		return { chat, models, show };
	}

	private client(baseUrl: string, apiKey?: string): OllamaClient {
		return new OllamaClient({ baseUrl, apiKey, timeoutMs: 30_000 });
	}

	async discoverModels(provider: ProviderEntity, apiKey?: string): Promise<ModelDraft[]> {
		const { models } = this.resolveEndpoints(provider);
		const client = this.client(stripSuffix(models, '/models'), apiKey);
		const ids = await client.listModels();
		return ids.map(id => ({ modelIdentifier: id, name: id, capabilities: { streaming: true } }));
	}

	async sendChat(ctx: ChatRequestContext): Promise<ChatResponse> {
		const client = this.client(stripSuffix(ctx.endpoint, '/chat/completions'), ctx.apiKey);
		const { content, raw } = await client.chat({
			model: ctx.model,
			messages: ctx.messages,
			// Ollama uses `format: 'json'` to force valid JSON output.
			...(ctx.responseFormat === 'json_object' && { format: 'json' }),
			...ctx.options
		});
		return { text: content, raw };
	}

	async *sendChatStream(ctx: ChatRequestContext): AsyncIterable<ChatStreamChunk> {
		const client = this.client(stripSuffix(ctx.endpoint, '/chat/completions'), ctx.apiKey);
		for await (const payload of client.chatStream({
			model: ctx.model,
			messages: ctx.messages,
			...(ctx.responseFormat === 'json_object' && { format: 'json' }),
			...ctx.options
		})) {
			yield parseOpenAiStreamChunk(payload);
		}
	}

	async showModelInfo(provider: ProviderEntity, modelIdentifier: string, apiKey?: string): Promise<Partial<ModelEntity>> {
		const { show } = this.resolveEndpoints(provider);
		const client = this.client(provider.baseUrl, apiKey);
		const info: OllamaModelInfo = await client.showModel(modelIdentifier, show!);
		return {
			apiValues: {
				contextWindow: info.contextLength,
				capabilities: {
					streaming: true,
					vision: info.supportsVision,
					toolCalling: info.supportsTools
				},
				parameterSize: info.parameterSize,
				quantizationLevel: info.quantizationLevel
			}
		};
	}

	async testConnection(provider: ProviderEntity, apiKey?: string): Promise<void> {
		const { models } = this.resolveEndpoints(provider);
		await this.client(stripSuffix(models, '/models'), apiKey).listModels();
	}
}

function stripSuffix(url: string, suffix: string): string {
	return url.endsWith(suffix) ? url.slice(0, -suffix.length) : url;
}
