import { CredentialMeta, ModelEntity, ProviderEntity } from './types';
import { ModelDraft } from './adapters/providerAdapter';

/** Minimal VS Code context surface — mockable in tests. */
export interface StorageContext {
	globalState: {
		get<T>(key: string): T | undefined;
		get<T>(key: string, defaultValue: T): T;
		update(key: string, value: unknown): Thenable<void>;
	};
	secrets: {
		get(key: string): Thenable<string | undefined>;
		store(key: string, value: string): Thenable<void>;
		delete(key: string): Thenable<void>;
	};
}

const DOC_KEY = 'skycode.core.v2';
const LEGACY_SETTINGS_KEY = 'skycode.settings';
const LEGACY_PROVIDER_SECRET = (pid: string) => `skycode.provider.${pid}.apiKey`;
export const credSecretKey = (credId: string) => `skycode.key.${credId}`;

export interface CoreDoc {
	version: 2;
	providers: ProviderEntity[];
	credentials: CredentialMeta[];
	models: ModelEntity[];
}

export function emptyDoc(): CoreDoc {
	return { version: 2, providers: [], credentials: [], models: [] };
}

export function uid(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Loads/persists the core document and migrates the legacy flat settings
 * shape (providers with inline keys/models) without losing user data.
 * Secrets keep their existing SecretStorage keys (`skycode.key.<id>`), so no
 * secret re-save is needed for credentials that already have one.
 */
export class CoreStorage {
	constructor(private readonly context: StorageContext) {}

	load(): CoreDoc {
		const doc = this.context.globalState.get<CoreDoc | undefined>(DOC_KEY);
		if (doc && doc.version === 2) {
			return doc;
		}
		return this.migrateLegacy();
	}

	async save(doc: CoreDoc): Promise<void> {
		await this.context.globalState.update(DOC_KEY, doc);
	}

	getSecret(credId: string): Thenable<string | undefined> {
		return this.context.secrets.get(credSecretKey(credId));
	}

	storeSecret(credId: string, value: string): Thenable<void> {
		return this.context.secrets.store(credSecretKey(credId), value);
	}

	deleteSecret(credId: string): Thenable<void> {
		return this.context.secrets.delete(credSecretKey(credId));
	}

	/** One-time migration from the legacy `skycode.settings` document. */
		private migrateLegacy(): CoreDoc {
		const doc = emptyDoc();
		const legacy = this.context.globalState.get<{ providers?: unknown[] }>(LEGACY_SETTINGS_KEY);
		if (!legacy?.providers) {
			return doc;
		}
				for (const raw of legacy.providers as any[]) {
			if (!raw?.id) {
				continue;
			}
			const providerId: string = raw.id;
			doc.providers.push({
				id: providerId,
				adapterType: raw.providerId === 'ollamaCloud' ? 'ollama' : String(raw.providerId),
				name: raw.displayName ?? 'Ollama',
				baseUrl: raw.baseUrl ?? '',
				modelsUrl: raw.modelsUrl,
				enabled: true,
				activeCredentialId: raw.activeKeyId
			});
			for (const key of raw.keys ?? []) {
				doc.credentials.push({
					id: key.id,
					providerId,
					name: key.label ?? 'Key',
					enabled: true,
					status: 'active'
				});
			}
			for (const m of raw.models ?? []) {
				const mid = typeof m === 'string' ? m : m?.id;
				if (!mid) {
					continue;
				}
				doc.models.push({
					id: mid,
					providerId,
					modelIdentifier: mid,
					name: mid,
					source: 'manual',
					enabled: true,
					contextWindow: typeof m === 'object' ? m.contextLength : undefined,
					capabilities: typeof m === 'object'
						? { streaming: m.supportsStreaming, vision: m.supportsVision, toolCalling: m.supportsTools }
						: undefined,
					parameterSize: typeof m === 'object' ? m.parameterSize : undefined,
					quantizationLevel: typeof m === 'object' ? m.quantizationLevel : undefined
				});
			}
			// Keep the legacy fallback secret reference in metadata so the
			// facade can still resolve it via getActiveKeySecret.
			if ((raw.keys ?? []).length === 0 && raw.hasApiKey) {
				doc.credentials.push({
					id: `legacy_${providerId}`,
					providerId,
					name: 'Migrated key',
					enabled: true,
					status: 'active'
				});
			}
		}
		return doc;
	}

	/** Legacy fallback: secret stored under the old provider-scoped key. */
	getLegacyProviderSecret(providerId: string): Thenable<string | undefined> {
		return this.context.secrets.get(LEGACY_PROVIDER_SECRET(providerId));
	}
}
