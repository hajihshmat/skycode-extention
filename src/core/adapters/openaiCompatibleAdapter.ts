import { ProviderEntity, ResponseFormat, ResponseType } from '../types';
import { joinUrl } from '../modelService';
import { OpenAIAdapter } from './openaiAdapter';

/**
 * OpenAI-compatible adapter for any user-configured service that speaks the
 * OpenAI wire format (LM Studio, vLLM, Together AI, Groq, internal proxies…).
 *
 * Reuses OpenAIAdapter via inheritance (DRY): only the identity and endpoint
 * resolution differ. There is deliberately NO default baseUrl — everything
 * comes from the user's provider config, and the standard overrides
 * (`provider.chatEndpoint`, `provider.modelsUrl`) are respected.
 */
export class OpenAICompatibleAdapter extends OpenAIAdapter {
	override readonly type = 'openai-compatible';
	override readonly displayName = 'OpenAI Compatible';
	override readonly requiresCredentials = true;
	override readonly supportedResponseTypes: ResponseType[] = ['chat-completion', 'response'];
	override readonly supportedResponseFormats: ResponseFormat[] = ['text', 'json_object'];

	/**
	 * Endpoint resolution for user-configured services:
	 *  - chat:   provider.chatEndpoint ?? '{baseUrl}/v1/chat/completions'
	 *  - models: provider.modelsUrl   ?? '{baseUrl}/v1/models'
	 * baseUrl is exactly what the user entered (no defaults, no rewriting) —
	 * only a trailing slash is normalized away.
	 */
	override resolveEndpoints(provider: ProviderEntity): { chat: string; models: string; show?: string } {
		const base = provider.baseUrl.replace(/\/+$/, '');
		return {
			chat: joinUrl(base, provider.chatEndpoint ?? '/v1/chat/completions'),
			models: provider.modelsUrl ?? joinUrl(base, '/v1/models')
		};
	}
}