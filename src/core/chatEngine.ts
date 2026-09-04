import { ChatMessageInput, ChatResponse, ChatStreamChunk } from './types';
import { resolveModel } from './modelService';
import { ProviderAdapter } from './adapters/providerAdapter';
import { getAdapter } from './adapterRegistry';
import { ProviderManager } from './providerManager';
import { ModelRegistry } from './modelRegistry';
import { CredentialStore } from './credentialStore';
import { CredentialManager } from './credentialManager';
import { CoreStorage } from './persistence';

export interface SendChatInput {
	providerId: string;
	modelIdentifier: string;
	messages: ChatMessageInput[];
	options?: Record<string, unknown>;
	signal?: AbortSignal;
}

const MAX_CREDENTIAL_ATTEMPTS = 3;

/**
 * Provider-agnostic chat orchestration:
 * provider → model → endpoint resolution → credential selection (with
 * rate-limit/invalid failover and cooldown) → adapter.sendChat().
 * No provider-specific logic lives here.
 */
export class ChatEngine {
	constructor(
		private readonly storage: CoreStorage,
		private readonly providers: ProviderManager,
		private readonly models: ModelRegistry,
		private readonly credentials: CredentialStore,
		private readonly adapterFor: (type: string) => ProviderAdapter = getAdapter
	) {}

	async sendChat(input: SendChatInput): Promise<ChatResponse> {
		const provider = this.providers.getProvider(input.providerId);
		if (!provider) {
			throw new Error(`Unknown provider "${input.providerId}"`);
		}
		if (!provider.enabled) {
			throw new Error(`Provider "${provider.name}" is disabled`);
		}
		const adapter = this.adapterFor(provider.adapterType);
		const model = this.models.getModel(provider.id, input.modelIdentifier);
		const resolved = model ? resolveModel(model) : undefined;
		const responseType = resolved?.responseType ?? 'chat-completion';
		const responseFormat = resolved?.responseFormat ?? 'text';
		if (responseType === 'response' && !adapter.sendResponse) {
			throw new Error(
				`Adapter "${provider.adapterType}" does not support the "response" response type. ` +
					'Choose "chat-completion" for this model or use a provider that supports it.'
			);
		}
		const endpoints = adapter.resolveEndpoints(provider);
		const creds = this.credentials.list(provider.id);
		const manager = new CredentialManager(creds);

		const attempts = creds.length > 0 ? Math.min(creds.length, MAX_CREDENTIAL_ATTEMPTS) : 1;
		let lastError: unknown;

		for (let attempt = 0; attempt < attempts; attempt++) {
			let apiKey: string | undefined;
			let activeCredId: string | undefined;

			if (creds.length > 0) {
				// User's preferred credential (activeCredentialId) is tried first;
				// failover to other credentials happens through rotation below.
				const cred = manager.getAvailableCredential(provider.activeCredentialId);
				if (!cred) {
					break; // all credentials rate-limited/invalid
				}
				activeCredId = cred.id;
				apiKey = await this.credentials.resolveSecret(cred);
			}

			try {
				if (input.signal?.aborted) {
					throw new DOMException('Request cancelled', 'AbortError');
				}
				const ctx = {
					endpoint: model?.endpointOverride
						? resolveModelEndpoint(endpoints.chat, model.endpointOverride)
						: endpoints.chat,
					apiKey,
					model: input.modelIdentifier,
					messages: input.messages,
					options: input.options,
					responseFormat,
					signal: input.signal
				};
				// No provider if/else: the adapter decides how each response type executes.
				const response = responseType === 'response'
					? await adapter.sendResponse!(ctx)
					: await adapter.sendChat(ctx);
				if (activeCredId) {
					manager.markSuccessful(activeCredId);
					await this.credentials.update(activeCredId, {
						status: 'active',
						cooldownUntil: undefined
					});
				}
				return response;
			} catch (err) {
				lastError = err;
				if (!activeCredId) {
					throw err; // no credentials involved — nothing to rotate
				}
				const kind = (err as { kind?: string }).kind;
				if (kind === 'rate-limited') {
					const retryAfter = (err as { retryAfterSec?: number }).retryAfterSec;
					manager.markRateLimited(activeCredId, retryAfter);
					await this.credentials.update(activeCredId, {
						status: 'rate-limited',
						cooldownUntil: Date.now() + (retryAfter && retryAfter > 0 ? retryAfter * 1000 : 60_000),
						lastError: 'Rate limited'
					});
					continue;
				}
				if (kind === 'invalid-credential') {
					manager.markInvalid(activeCredId);
					await this.credentials.update(activeCredId, { status: 'invalid', lastError: 'Invalid credential' });
					continue;
				}
				throw err; // network/request/server errors don't rotate credentials
			}
		}

		throw new Error(
			`All credentials for provider "${provider.name}" are rate-limited or invalid. ` +
				'Wait for the cooldown to pass, disable the affected keys, or add another credential.'
		);
	}

	/**
	 * Streaming variant of sendChat with identical credential selection and
	 * rotation policy:
	 *  - The provider's activeCredentialId (user choice) is tried first.
	 *  - Errors received before the first chunk (e.g. HTTP 429/401 returned
	 *    before the stream starts) rotate credentials exactly like sendChat.
	 *  - Errors after the first chunk (mid-stream disconnect etc.) are
	 *    re-thrown to the caller — partial output must not be silently retried.
	 */
	async *sendChatStream(input: SendChatInput): AsyncGenerator<ChatStreamChunk> {
		const provider = this.providers.getProvider(input.providerId);
		if (!provider) {
			throw new Error(`Unknown provider "${input.providerId}"`);
		}
		if (!provider.enabled) {
			throw new Error(`Provider "${provider.name}" is disabled`);
		}
		const adapter = this.adapterFor(provider.adapterType);
		const model = this.models.getModel(provider.id, input.modelIdentifier);
		const resolvedStream = model ? resolveModel(model) : undefined;
		const streamResponseType = resolvedStream?.responseType ?? 'chat-completion';
		// Pick the streaming method for the model's response type; the adapter
		// decides how each response type streams — no provider if/else here.
		const streamAdapter = streamResponseType === 'response' ? adapter.sendResponseStream : adapter.sendChatStream;
		if (!streamAdapter) {
			throw new Error(
				streamResponseType === 'response'
					? `Adapter "${provider.adapterType}" does not support streaming for the "response" response type. ` +
						'Use "chat-completion" for streaming models.'
					: `Adapter "${provider.adapterType}" does not support streaming`
			);
		}
		const endpoints = adapter.resolveEndpoints(provider);
		const creds = this.credentials.list(provider.id);
		const manager = new CredentialManager(creds);

		const attempts = creds.length > 0 ? Math.min(creds.length, MAX_CREDENTIAL_ATTEMPTS) : 1;
		let yielded = false;

		for (let attempt = 0; attempt < attempts; attempt++) {
			let apiKey: string | undefined;
			let activeCredId: string | undefined;

			if (creds.length > 0) {
				const cred = manager.getAvailableCredential(provider.activeCredentialId);
				if (!cred) {
					break; // all credentials rate-limited/invalid
				}
				activeCredId = cred.id;
				apiKey = await this.credentials.resolveSecret(cred);
			}

			try {
				for await (const chunk of streamAdapter.call(adapter, {
					endpoint: model?.endpointOverride
						? resolveModelEndpoint(endpoints.chat, model.endpointOverride)
						: endpoints.chat,
					apiKey,
					model: input.modelIdentifier,
					messages: input.messages,
					options: input.options,
					responseFormat: resolvedStream?.responseFormat ?? 'text',
					signal: input.signal
				})) {
					if (!yielded) {
						yielded = true; // stream started — rotation no longer possible
						if (activeCredId) {
							manager.markSuccessful(activeCredId);
							await this.credentials.update(activeCredId, {
								status: 'active',
								cooldownUntil: undefined
							});
						}
					}
					yield chunk;
					if (chunk.done) {
						return;
					}
				}
				return; // stream ended without a done chunk
			} catch (err) {
				if (input.signal?.aborted) {
					return;
				}
				// Mid-stream failure or no credentials involved: report, don't rotate.
				if (yielded || !activeCredId) {
					throw err;
				}
				const kind = (err as { kind?: string }).kind;
				if (kind === 'rate-limited') {
					const retryAfter = (err as { retryAfterSec?: number }).retryAfterSec;
					manager.markRateLimited(activeCredId, retryAfter);
					await this.credentials.update(activeCredId, {
						status: 'rate-limited',
						cooldownUntil: Date.now() + (retryAfter && retryAfter > 0 ? retryAfter * 1000 : 60_000),
						lastError: 'Rate limited'
					});
					continue;
				}
				if (kind === 'invalid-credential') {
					manager.markInvalid(activeCredId);
					await this.credentials.update(activeCredId, { status: 'invalid', lastError: 'Invalid credential' });
					continue;
				}
				throw err; // network/request/server errors don't rotate credentials
			}
		}

		throw new Error(
			`All credentials for provider "${provider.name}" are rate-limited or invalid. ` +
				'Wait for the cooldown to pass, disable the affected keys, or add another credential.'
		);
	}
}

/** Model endpoint override wins; absolute URLs are used as-is. */
function resolveModelEndpoint(providerEndpoint: string, override: string): string {
	if (/^https?:\/\//i.test(override)) {
		return override;
	}
	const base = providerEndpoint.replace(/\/chat\/completions.*$/, '').replace(/\/+$/, '');
	return `${base}/${override.replace(/^\/+/, '')}`;
}
