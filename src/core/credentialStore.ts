import { CredentialMeta } from './types';
import { CoreStorage, uid } from './persistence';

/** Credential metadata CRUD (secrets handled through CoreStorage). */
export class CredentialStore {
	constructor(private readonly storage: CoreStorage) {}

	list(providerId?: string): CredentialMeta[] {
		const doc = this.storage.load();
		return providerId ? doc.credentials.filter(c => c.providerId === providerId) : doc.credentials;
	}

	async add(providerId: string, name: string, secret?: string): Promise<CredentialMeta> {
		const doc = this.storage.load();
		const cred: CredentialMeta = { id: uid('cred'), providerId, name, enabled: true, status: 'active' };
		doc.credentials.push(cred);
		const provider = doc.providers.find(p => p.id === providerId);
		if (provider && !provider.activeCredentialId) {
			provider.activeCredentialId = cred.id;
		}
		await this.storage.save(doc);
		if (secret) {
			await this.storage.storeSecret(cred.id, secret);
		}
		return cred;
	}

	async update(
		credId: string,
		patch: Partial<Omit<CredentialMeta, 'id' | 'providerId'>>,
		secret?: string
	): Promise<void> {
		const doc = this.storage.load();
		const cred = doc.credentials.find(c => c.id === credId);
		if (!cred) {
			return;
		}
		Object.assign(cred, patch);
		await this.storage.save(doc);
		if (secret) {
			await this.storage.storeSecret(credId, secret);
		}
	}

	async remove(credId: string): Promise<void> {
		const doc = this.storage.load();
		doc.credentials = doc.credentials.filter(c => c.id !== credId);
		const provider = doc.providers.find(p => p.activeCredentialId === credId);
		if (provider) {
			provider.activeCredentialId = doc.credentials.find(c => c.providerId === provider.id)?.id;
		}
		await this.storage.save(doc);
		await this.storage.deleteSecret(credId);
	}

	/** Secret of a credential; falls back to the legacy provider-scoped key. */
	async resolveSecret(cred: CredentialMeta): Promise<string | undefined> {
		const secret = await this.storage.getSecret(cred.id);
		if (secret !== undefined) {
			return secret;
		}
		if (cred.id.startsWith('legacy_')) {
			return this.storage.getLegacyProviderSecret(cred.providerId);
		}
		return undefined;
	}
}
