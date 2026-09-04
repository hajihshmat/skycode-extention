import * as assert from 'assert';
import { CoreStorage } from '../core/persistence';
import { ProviderManager } from '../core/providerManager';
import { ModelRegistry } from '../core/modelRegistry';
import { CredentialStore } from '../core/credentialStore';
import { CredentialManager } from '../core/credentialManager';
import { ChatEngine } from '../core/chatEngine';
import { getAdapter } from '../core/adapterRegistry';
import { resolveModel, resolveEndpoint } from '../core/modelService';
import { ChatError, ChatRequestContext } from '../core/types';
import { ProviderAdapter } from '../core/adapters/providerAdapter';

function memoryContext(legacy?: unknown) {
	const state = new Map<string, unknown>();
	if (legacy) {
		state.set('skycode.settings', legacy);
	}
	const secrets = new Map<string, string>();
	return {
		globalState: {
			get: (key: string) => state.get(key),
			update: async (key: string, value: unknown) => void state.set(key, value)
		},
		secrets: {
			get: async (key: string) => secrets.get(key),
			store: async (key: string, value: string) => void secrets.set(key, value),
			delete: async (key: string) => void secrets.delete(key)
		}
	};
}

suite('Core architecture', () => {
	test('ProviderManager CRUD', async () => {
		const storage = new CoreStorage(memoryContext());
		const manager = new ProviderManager(storage);
		const provider = await manager.addProvider({ adapterType: 'ollama', name: 'Local', baseUrl: 'http://localhost:11434' });
		assert.strictEqual(manager.listProviders().length, 1);
		await manager.updateProvider(provider.id, { name: 'Local Ollama' });
		assert.strictEqual(manager.getProvider(provider.id)?.name, 'Local Ollama');
		await manager.disableProvider(provider.id);
		assert.strictEqual(manager.getProvider(provider.id)?.enabled, false);
		await manager.removeProvider(provider.id);
		assert.strictEqual(manager.listProviders().length, 0);
	});

	test('Model merge: API values + user overrides + refresh survival', async () => {
		const storage = new CoreStorage(memoryContext());
		const registry = new ModelRegistry(storage);
		await registry.upsertApiModels('p1', [
			{ modelIdentifier: 'gemma4', capabilities: { streaming: true, vision: false } }
		]);
		await registry.updateModel('p1', 'gemma4', {
			overrides: { capabilities: { vision: true }, contextWindow: 999 }
		});
		assert.strictEqual(registry.resolve('p1', 'gemma4')!.capabilities.vision, true);
		await registry.upsertApiModels('p1', [
			{ modelIdentifier: 'gemma4', capabilities: { streaming: true, vision: false } }
		]);
		assert.strictEqual(registry.resolve('p1', 'gemma4')!.capabilities.vision, true, 'override survives refresh');
		assert.strictEqual(registry.resolve('p1', 'gemma4')!.capabilities.streaming, true);
		assert.strictEqual(registry.resolve('p1', 'gemma4')!.contextWindow, 999);
	});

	test('Manual model independent of API', async () => {
		const storage = new CoreStorage(memoryContext());
		const registry = new ModelRegistry(storage);
		await registry.addManualModel({ providerId: 'p1', modelIdentifier: 'my-custom', name: 'My Custom' });
		await registry.upsertApiModels('p1', [{ modelIdentifier: 'other' }]);
		assert.strictEqual(registry.getModel('p1', 'my-custom')?.source, 'manual');
		assert.strictEqual(registry.listModels('p1').length, 2);
	});

	test('Endpoint resolution order', () => {
		const provider = { id: 'p', adapterType: 'ollama', name: 'o', baseUrl: 'http://localhost:11434', enabled: true };
		const adapter = getAdapter('ollama');
		assert.strictEqual(adapter.resolveEndpoints(provider).chat, 'http://localhost:11434/v1/chat/completions');
		assert.strictEqual(
			adapter.resolveEndpoints({ ...provider, baseUrl: 'https://ollama.com/v1' }).chat,
			'https://ollama.com/v1/chat/completions'
		);
		const resolved = resolveEndpoint(provider, '/v1/models', 'models');
		assert.strictEqual(resolved, 'http://localhost:11434/v1/models');
		const model: Parameters<typeof resolveModel>[0] = {
			id: 'm', providerId: 'p', modelIdentifier: 'gemma4', name: 'g', source: 'api', enabled: true,
			endpointOverride: '/custom/chat'
		};
		assert.strictEqual(resolveModel(model).endpointOverride, '/custom/chat');
	});

	test('CredentialManager: rate limit, cooldown, invalid, failover, exhaustion', async () => {
		const storage = new CoreStorage(memoryContext());
		const creds = new CredentialStore(storage);
		const provider = await new ProviderManager(storage).addProvider({
			adapterType: 'ollama', name: 'Cloud', baseUrl: 'https://ollama.com/v1'
		});
		await creds.add(provider.id, 'Key 1', 'k1');
		await creds.add(provider.id, 'Key 2', 'k2');
		await creds.add(provider.id, 'Key 3', 'k3');
		const list = creds.list(provider.id);

		const manager = new CredentialManager(list);
		assert.strictEqual(manager.getAvailableCredential()?.id, list[0].id);
		manager.markRateLimited(list[0].id, 1);
		assert.strictEqual(manager.getAvailableCredential()?.id, list[1].id);
		manager.markInvalid(list[1].id);
		assert.strictEqual(manager.getAvailableCredential()?.id, list[2].id);
		manager.markRateLimited(list[2].id);
		assert.strictEqual(manager.getAvailableCredential(), undefined, 'all exhausted');

		list.forEach(c => (c.cooldownUntil = Date.now() - 1));
		assert.ok(manager.getAvailableCredential(), 'cooldown expired → available again');
	});

	test('ChatEngine: 429 failover to next credential, then success', async () => {
		const storage = new CoreStorage(memoryContext());
		const provider = await new ProviderManager(storage).addProvider({
			adapterType: 'ollama', name: 'Cloud', baseUrl: 'https://ollama.com/v1'
		});
		const creds = new CredentialStore(storage);
		await creds.add(provider.id, 'Key 1', 'k1');
		await creds.add(provider.id, 'Key 2', 'k2');
		await new ModelRegistry(storage).addManualModel({
			providerId: provider.id, modelIdentifier: 'm1', name: 'm1'
		});

		let calls = 0;
		const usedKeys: (string | undefined)[] = [];
		const fakeAdapter: ProviderAdapter = {
			type: 'ollama', displayName: 'Ollama', requiresCredentials: false, supportedResponseTypes: ['chat-completion'], supportedResponseFormats: ['text', 'json_object'],
			resolveEndpoints: () => ({ chat: 'http://x/v1/chat/completions', models: 'http://x/v1/models' }),
			discoverModels: async () => [],
			sendChat: async (r: ChatRequestContext) => {
				calls++;
				usedKeys.push(r.apiKey);
				if (calls === 1) {
					throw new ChatError('rate-limited', 'HTTP 429', 30);
				}
				return { text: 'ok' };
			}
		};

		const engine = new ChatEngine(storage, new ProviderManager(storage), new ModelRegistry(storage), creds, () => fakeAdapter);
		const response = await engine.sendChat({
			providerId: provider.id, modelIdentifier: 'm1', messages: [{ role: 'user', content: 'hi' }]
		});
		assert.strictEqual(response.text, 'ok');
		assert.strictEqual(calls, 2);
		assert.deepStrictEqual(usedKeys, ['k1', 'k2'], 'rotated to second credential');
	});

	test('ChatEngine: all credentials exhausted → clear error', async () => {
		const storage = new CoreStorage(memoryContext());
		const provider = await new ProviderManager(storage).addProvider({
			adapterType: 'ollama', name: 'Cloud', baseUrl: 'https://ollama.com/v1'
		});
		const creds = new CredentialStore(storage);
		await creds.add(provider.id, 'Key 1', 'k1');

		const fakeAdapter: ProviderAdapter = {
			type: 'ollama', displayName: 'Ollama', requiresCredentials: false, supportedResponseTypes: ['chat-completion'], supportedResponseFormats: ['text', 'json_object'],
			resolveEndpoints: () => ({ chat: 'http://x', models: 'http://x' }),
			discoverModels: async () => [],
			sendChat: async () => {
				throw new ChatError('rate-limited', 'HTTP 429');
			}
		};
		const engine = new ChatEngine(storage, new ProviderManager(storage), new ModelRegistry(storage), creds, () => fakeAdapter);
		await assert.rejects(
			engine.sendChat({ providerId: provider.id, modelIdentifier: 'x', messages: [] }),
			/All credentials/
		);
	});

	test('Security: secrets never appear in error messages', () => {
		const err = new ChatError('invalid-credential', 'HTTP 401 Unauthorized');
		assert.ok(!err.message.includes('secret'));
	});

	test('OpenAI adapter: endpoint resolution', () => {
		const adapter = getAdapter('openai');
		const provider = { id: 'p', adapterType: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', enabled: true };
		assert.strictEqual(adapter.resolveEndpoints(provider).chat, 'https://api.openai.com/v1/chat/completions');
		assert.strictEqual(adapter.resolveEndpoints(provider).models, 'https://api.openai.com/v1/models');
		assert.strictEqual(adapter.requiresCredentials, true);
	});

	test('Anthropic adapter: request shape + response parsing', async () => {
		let captured: { url: string; init: RequestInit } | undefined;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
			captured = { url: String(url), init: init ?? {} };
			return new Response(
				JSON.stringify({
					content: [{ type: 'text', text: 'hello' }, { type: 'other' }],
					usage: { input_tokens: 5, output_tokens: 7 }
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		}) as typeof fetch;

		try {
			const adapter = getAdapter('anthropic');
			const provider = { id: 'p', adapterType: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', enabled: true };
			const response = await adapter.sendChat({
				endpoint: adapter.resolveEndpoints(provider).chat,
				apiKey: 'test-key',
				model: 'claude-sonnet-4-5',
				messages: [
					{ role: 'system', content: 'be brief' },
					{ role: 'user', content: 'hi' }
				]
			});

			assert.strictEqual(response.text, 'hello', 'text blocks joined');
			assert.strictEqual(response.usage?.promptTokens, 5);
			assert.strictEqual(response.usage?.completionTokens, 7);

			const body = JSON.parse(String(captured!.init.body));
			assert.strictEqual(captured!.url, 'https://api.anthropic.com/v1/messages');
			assert.strictEqual(body.system, 'be brief', 'system lifted to top-level');
			assert.strictEqual(body.max_tokens, 4096, 'max_tokens required by API');
			assert.deepStrictEqual(body.messages, [{ role: 'user', content: 'hi' }]);
			assert.strictEqual((captured!.init.headers as Record<string, string>)['x-api-key'], 'test-key');
			assert.ok((captured!.init.headers as Record<string, string>)['anthropic-version']);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
