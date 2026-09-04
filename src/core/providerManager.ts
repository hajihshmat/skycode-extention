import { ProviderEntity } from './types';
import { CoreStorage, uid } from './persistence';

/**
 * Provider CRUD on top of the core document. Adapters are resolved through
 * the adapter registry — the manager is provider-agnostic.
 */
export class ProviderManager {
	constructor(private readonly storage: CoreStorage) {}

	listProviders(): ProviderEntity[] {
		return this.storage.load().providers;
	}

	getProvider(id: string): ProviderEntity | undefined {
		return this.storage.load().providers.find(p => p.id === id);
	}

	async addProvider(input: Omit<ProviderEntity, 'id' | 'enabled'> & { enabled?: boolean }): Promise<ProviderEntity> {
		const doc = this.storage.load();
		const provider: ProviderEntity = { ...input, id: uid('prov'), enabled: input.enabled ?? true };
		doc.providers.push(provider);
		await this.storage.save(doc);
		return provider;
	}

	async updateProvider(id: string, patch: Partial<ProviderEntity>): Promise<ProviderEntity | undefined> {
		const doc = this.storage.load();
		const provider = doc.providers.find(p => p.id === id);
		if (!provider) {
			return undefined;
		}
		Object.assign(provider, patch);
		await this.storage.save(doc);
		return provider;
	}

	async enableProvider(id: string): Promise<void> {
		await this.updateProvider(id, { enabled: true });
	}

	async disableProvider(id: string): Promise<void> {
		await this.updateProvider(id, { enabled: false });
	}

	async removeProvider(id: string): Promise<void> {
		const doc = this.storage.load();
		doc.providers = doc.providers.filter(p => p.id !== id);
		const creds = doc.credentials.filter(c => c.providerId === id);
		doc.credentials = doc.credentials.filter(c => c.providerId !== id);
		doc.models = doc.models.filter(m => m.providerId !== id);
		await this.storage.save(doc);
		await Promise.all(creds.map(c => this.storage.deleteSecret(c.id)));
	}
}
