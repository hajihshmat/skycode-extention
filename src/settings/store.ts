import * as vscode from 'vscode';
import { CoreStorage } from '../core/persistence';
import { ProviderManager } from '../core/providerManager';
import { ModelRegistry } from '../core/modelRegistry';
import { CredentialStore } from '../core/credentialStore';
import { resolveModel } from '../core/modelService';
import { getAdapter } from '../core/adapterRegistry';
import { Capabilities, ModelEntity, ProviderEntity, ResponseFormat, ResponseType } from '../core/types';
import { ModelDraft } from '../core/adapters/providerAdapter';
import { ProviderSettingsEntry, SkyCodeSettings } from './types';

/** UI-facing catalog id ↔ core adapter type. */
const ADAPTER_TO_UI: Record<string, string> = { ollama: 'ollamaCloud' };

/**
 * Facade over the core provider/model/credential services. Keeps the legacy
 * settings API (and therefore the existing webview UI) working while the new
 * architecture lives underneath.
 */
export class SettingsStore {
	private readonly storage: CoreStorage;
	private readonly providers: ProviderManager;
	private readonly models: ModelRegistry;
	private readonly credentials: CredentialStore;

	constructor(context: vscode.ExtensionContext) {
		this.storage = new CoreStorage(context);
		this.providers = new ProviderManager(this.storage);
		this.models = new ModelRegistry(this.storage);
		this.credentials = new CredentialStore(this.storage);
	}

	getSettings(): SkyCodeSettings {
		return {
			providers: this.providers.listProviders().map(p => this.toLegacyEntry(p))
		};
	}

	/** Keep drafts of the last discovery run so selected models are saved as 'api'. */
	stageDiscovered(providerId: string, drafts: { modelIdentifier: string; capabilities?: Capabilities }[]): void {
		this.models.stageDiscovered(providerId, drafts);
	}

	async withKeyFlags(settings: SkyCodeSettings): Promise<SkyCodeSettings> {
		const providers = await Promise.all(
			settings.providers.map(async p => ({ ...p, hasApiKey: await this.hasApiKey(p.id) }))
		);
		return { providers };
	}

	private async hasApiKey(providerId: string): Promise<boolean> {
		return (await this.getActiveKeySecret(providerId)) !== undefined;
	}

	/** Secret for the provider's active credential (legacy fallback included). */
	async getActiveKeySecret(providerId: string): Promise<string | undefined> {
		const provider = this.providers.getProvider(providerId);
		if (!provider) {
			return undefined;
		}
		const creds = this.credentials.list(providerId);
		const cred = creds.find(c => c.id === provider.activeCredentialId) ?? creds[0];
		if (cred) {
			return this.credentials.resolveSecret(cred);
		}
		return this.storage.getLegacyProviderSecret(providerId);
	}

	async saveProvider(entry: ProviderSettingsEntry): Promise<void> {
		const configPatch = {
			name: entry.displayName,
			baseUrl: entry.baseUrl,
			modelsUrl: entry.modelsUrl,
			chatEndpoint: entry.chatEndpoint
		};
		let provider = this.providers.getProvider(entry.id);
		if (!provider) {
			provider = await this.providers.addProvider({
				adapterType: entry.providerId === 'ollamaCloud' ? 'ollama' : entry.providerId,
				...configPatch
			});
		} else {
			await this.providers.updateProvider(provider.id, configPatch);
		}

		const staged = new Map(this.models.takeStaged(provider.id).map(d => [d.modelIdentifier, d]));
		for (const m of entry.models) {
			await this.upsertFromUi(provider.id, m, staged.get(m.id));
		}
	}

	/** Upsert a UI model entry, computing overrides against the API snapshot. */
	private async upsertFromUi(
		providerId: string,
		m: ProviderSettingsEntry['models'][number],
		stagedDraft?: ModelDraft
	): Promise<void> {
		const existing = this.models.getModel(providerId, m.id);
		const finalCaps: Capabilities = {
			streaming: m.supportsStreaming,
			vision: m.supportsVision,
			toolCalling: m.supportsTools
		};
		const patch: Partial<ModelEntity> = {
			name: m.id,
			parameterSize: m.parameterSize,
			quantizationLevel: m.quantizationLevel
		};
		// User's response-type/format choices live in overrides (survive refreshes).
		const responseTypePatch = { responseType: m.responseType as ResponseType | undefined };
		const responseFormatPatch = { responseFormat: m.responseFormat as ResponseFormat | undefined };

		const apiCaps = existing?.apiValues?.capabilities ?? stagedDraft?.capabilities;
		if (apiCaps) {
			// API-backed model: user edits become overrides where they differ.
			const capOverrides: Capabilities = {};
			for (const [key, value] of Object.entries(finalCaps)) {
				if (value !== undefined && apiCaps[key] !== value) {
					capOverrides[key] = value;
				}
			}
			patch.overrides = {
				...existing?.overrides,
				capabilities: capOverrides,
				contextWindow:
					m.contextLength !== undefined && existing?.apiValues?.contextWindow !== m.contextLength
						? m.contextLength
						: existing?.overrides?.contextWindow,
				...responseTypePatch,
				...responseFormatPatch
			};
		} else {
			patch.capabilities = finalCaps;
			patch.contextWindow = m.contextLength;
			patch.overrides = { ...existing?.overrides, ...responseTypePatch, ...responseFormatPatch };
		}

		if (existing) {
			await this.models.updateModel(providerId, m.id, patch);
		} else if (stagedDraft) {
			// Selected from discovery → keep the API snapshot for future merges.
			await this.models.upsertApiModels(providerId, [stagedDraft]);
			await this.models.updateModel(providerId, m.id, patch);
		} else {
			await this.models.addManualModel({
				providerId,
				modelIdentifier: m.id,
				...patch
			} as Omit<ModelEntity, 'id' | 'source' | 'enabled'>);
		}
	}

	async deleteProvider(id: string): Promise<void> {
		await this.providers.removeProvider(id);
	}

	async saveKey(providerId: string, keyId: string, label: string, value?: string): Promise<void> {
		if (!keyId) {
			await this.credentials.add(providerId, label, value);
		} else {
			await this.credentials.update(keyId, { name: label }, value);
		}
	}

	async deleteKey(_providerId: string, keyId: string): Promise<void> {
		await this.credentials.remove(keyId);
	}

	async setActiveKey(providerId: string, keyId: string): Promise<void> {
		await this.providers.updateProvider(providerId, { activeCredentialId: keyId });
	}

	/** Map a core provider (+credentials/models) to the legacy UI entry. */
	private toLegacyEntry(provider: ProviderEntity): ProviderSettingsEntry {
		const models = this.models.listModels(provider.id).filter(m => m.enabled);
		const creds = this.credentials.list(provider.id);
		const adapter = getAdapter(provider.adapterType);
		return {
			id: provider.id,
			providerId: ADAPTER_TO_UI[provider.adapterType] ?? provider.adapterType,
			displayName: provider.name,
			baseUrl: provider.baseUrl,
			modelsUrl: provider.modelsUrl,
			chatEndpoint: provider.chatEndpoint,
			supportedResponseTypes: adapter.supportedResponseTypes,
			supportedResponseFormats: adapter.supportedResponseFormats,
			models: models.map(m => {
				const resolved = resolveModel(m);
				return {
					id: m.modelIdentifier,
					responseType: resolved.responseType,
					responseFormat: resolved.responseFormat,
					contextLength: resolved.contextWindow,
					supportsStreaming: resolved.capabilities.streaming,
					supportsVision: resolved.capabilities.vision,
					supportsTools: resolved.capabilities.toolCalling,
					parameterSize: m.parameterSize,
					quantizationLevel: m.quantizationLevel
				};
			}),
			defaultModel: undefined,
			keys: creds.map(c => ({ id: c.id, label: c.name })),
			activeKeyId: provider.activeCredentialId,
			hasApiKey: false
		};
	}
}
