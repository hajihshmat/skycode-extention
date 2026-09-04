import { ModelEntity, ResolvedModel } from './types';
import { CoreStorage, uid } from './persistence';
import { ModelDraft } from './adapters/providerAdapter';
import { resolveModel } from './modelService';

/**
 * Model registry: manual + API models, override-aware.
 * `stageDiscovered` keeps drafts of a discovery run so the UI can add only
 * the user-selected ones as `source: 'api'`.
 */
export class ModelRegistry {
	private staged = new Map<string, ModelDraft[]>(); // providerId → last discovery drafts

	constructor(private readonly storage: CoreStorage) {}

	listModels(providerId?: string): ModelEntity[] {
		const doc = this.storage.load();
		return providerId ? doc.models.filter(m => m.providerId === providerId) : doc.models;
	}

	getModel(providerId: string, modelIdentifier: string): ModelEntity | undefined {
		return this.storage
			.load()
			.models.find(m => m.providerId === providerId && m.modelIdentifier === modelIdentifier);
	}

	stageDiscovered(providerId: string, drafts: ModelDraft[]): void {
		this.staged.set(providerId, drafts);
	}

	takeStaged(providerId: string): ModelDraft[] {
		return this.staged.get(providerId) ?? [];
	}

	/** Add a manually configured model. */
	async addManualModel(
		model: Omit<ModelEntity, 'id' | 'source' | 'enabled'> & { enabled?: boolean }
	): Promise<ModelEntity> {
		const doc = this.storage.load();
		const entity: ModelEntity = { ...model, id: uid('model'), source: 'manual', enabled: model.enabled ?? true };
		doc.models.push(entity);
		await this.storage.save(doc);
		return entity;
	}

	/**
	 * Insert/refresh API-discovered models. Manual models and user overrides
	 * are preserved — only the apiValues snapshot is refreshed.
	 */
	async upsertApiModels(providerId: string, drafts: ModelDraft[]): Promise<void> {
		const doc = this.storage.load();
		for (const draft of drafts) {
			const existing = doc.models.find(
				m => m.providerId === providerId && m.modelIdentifier === draft.modelIdentifier
			);
			const apiValues = {
				contextWindow: draft.contextWindow,
				capabilities: draft.capabilities,
				parameterSize: draft.parameterSize,
				quantizationLevel: draft.quantizationLevel
			};
			if (existing) {
				existing.source = existing.source === 'manual' ? existing.source : 'api';
				existing.apiValues = apiValues;
			} else {
				doc.models.push({
					id: uid('model'),
					providerId,
					modelIdentifier: draft.modelIdentifier,
					name: draft.name ?? draft.modelIdentifier,
					source: 'api',
					enabled: true,
					apiValues
				});
			}
		}
		await this.storage.save(doc);
	}

	async updateModel(
		providerId: string,
		modelIdentifier: string,
		patch: Partial<ModelEntity>
	): Promise<ModelEntity | undefined> {
		const doc = this.storage.load();
		const model = doc.models.find(m => m.providerId === providerId && m.modelIdentifier === modelIdentifier);
		if (!model) {
			return undefined;
		}
		Object.assign(model, patch);
		await this.storage.save(doc);
		return model;
	}

	async removeModel(providerId: string, modelIdentifier: string): Promise<void> {
		const doc = this.storage.load();
		doc.models = doc.models.filter(m => !(m.providerId === providerId && m.modelIdentifier === modelIdentifier));
		await this.storage.save(doc);
	}

	/** Final merged configuration for a model (API + overrides). */
	resolve(providerId: string, modelIdentifier: string): ResolvedModel | undefined {
		const model = this.getModel(providerId, modelIdentifier);
		return model ? resolveModel(model) : undefined;
	}
}
