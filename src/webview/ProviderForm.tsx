import { FormEvent, useEffect, useState } from 'react';
import { ProviderSettingsEntry } from '../settings/types';
import { ModelListEditor, mergeFetchedModels } from './ModelListEditor';
import { KeysEditor } from './KeysEditor';
import { KeyOps } from './keyOps';

export interface SavePayload {
	entry: ProviderSettingsEntry;
}

export interface ModelsFetchState {
	requestId: string;
	pending: boolean;
	error?: string;
	models?: string[];
}

interface ProviderFormProps extends KeyOps {
	entry: ProviderSettingsEntry;
	isNew: boolean;
	modelsFetch: ModelsFetchState | null;
	modelInfoResults: import('../settings/types').ModelInfoFetchedMessage[];
	onCancel: () => void;
	onSave: (payload: SavePayload) => void;
}

const urlPattern = /^https?:\/\/\S+$/;

export function ProviderForm({
	entry,
	isNew,
	modelsFetch,
	modelInfoResults,
	onCancel,
	onSave,
	onSaveKey,
	onDeleteKey,
	onSetActiveKey,
	onFetchModels,
	onFetchModelInfo,
	onConsumeInfoResults
}: ProviderFormProps) {
	const [displayName, setDisplayName] = useState(entry.displayName);
	const [baseUrl, setBaseUrl] = useState(entry.baseUrl);
	const [modelsUrl, setModelsUrl] = useState(entry.modelsUrl?.trim() || `${entry.baseUrl}/models`);
	const [models, setModels] = useState(entry.models);
	const [defaultModel, setDefaultModel] = useState(entry.defaultModel ?? '');
	const [touched, setTouched] = useState<Record<string, boolean>>({});
	const [lastHandledFetch, setLastHandledFetch] = useState<string | null>(null);
	const [fetchedModels, setFetchedModels] = useState<string[] | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [infoPending, setInfoPending] = useState<Set<string>>(new Set());
	const [infoErrors, setInfoErrors] = useState<Record<string, string>>({});

	// Auto-fill results from Ollama /api/show land here and update their row.
	useEffect(() => {
		if (modelInfoResults.length === 0) {
			return;
		}
		setModels(prev =>
			prev.map(m => {
				const result = modelInfoResults.find(r => r.modelId === m.id);
				if (!result || result.error) {
					return m;
				}
				return {
					...m,
					contextLength: result.contextLength ?? m.contextLength,
					supportsVision: result.supportsVision ?? m.supportsVision,
					supportsTools: result.supportsTools ?? m.supportsTools,
					parameterSize: result.parameterSize,
					quantizationLevel: result.quantizationLevel
				};
			})
		);
		setInfoPending(prev => {
			const next = new Set(prev);
			for (const r of modelInfoResults) {
				next.delete(r.modelId);
			}
			return next;
		});
		setInfoErrors(prev => {
			const next = { ...prev };
			for (const r of modelInfoResults) {
				if (r.error) {
					next[r.modelId] = r.error;
				} else {
					delete next[r.modelId];
				}
			}
			return next;
		});
		onConsumeInfoResults(modelInfoResults.map(r => r.requestId));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [modelInfoResults]);

	const autoFillInfo = (modelId: string) => {
		if (infoPending.has(modelId)) {
			return;
		}
		setInfoPending(prev => new Set(prev).add(modelId));
		onFetchModelInfo(entry.id, `info_${Date.now().toString(36)}`, modelId);
	};

	const errors = {
		displayName: displayName.trim() ? undefined : 'A name is required so you can recognise this provider.',
		baseUrl: urlPattern.test(baseUrl.trim())
			? undefined
			: 'Enter a valid endpoint starting with http:// or https://.'
	};
	const showError = (field: keyof typeof errors) =>
		touched[field] && errors[field] ? errors[field] : undefined;

	// When the host responds, offer the fetched models for selection.
	if (modelsFetch && !modelsFetch.pending && modelsFetch.requestId !== lastHandledFetch) {
		setLastHandledFetch(modelsFetch.requestId);
		if (modelsFetch.models) {
			setFetchedModels(modelsFetch.models);
			setSelected(new Set());
		} else {
			setFetchedModels(null);
		}
	}

	const toggleSelected = (id: string) => {
		setSelected(prev => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	};

	const addSelectedModels = () => {
		setModels(prev => mergeFetchedModels(prev, [...selected]));
		setFetchedModels(null);
		setSelected(new Set());
	};

	const handleSubmit = (e: FormEvent) => {
		e.preventDefault();
		setTouched({ displayName: true, baseUrl: true });
		if (errors.displayName || errors.baseUrl) {
			return;
		}
		onSave({
			entry: {
				...entry,
				displayName: displayName.trim(),
				baseUrl: baseUrl.trim(),
				modelsUrl: modelsUrl.trim(),
				models,
				defaultModel: models.some(m => m.id === defaultModel)
					? defaultModel
					: models[0]?.id
			}
		});
	};

	return (
		<form className="page" onSubmit={handleSubmit} noValidate>
			<div className="page-header">
				<h1 className="heading">{isNew ? 'Add provider' : 'Edit provider'}</h1>
				<button type="button" className="btn btn--ghost" onClick={onCancel} aria-label="Cancel">
					Cancel
				</button>
			</div>

			<div className="field">
				<label className="field__label" htmlFor="f-name">Name</label>
				<input
					id="f-name"
					className="input"
					value={displayName}
					onChange={e => setDisplayName(e.target.value)}
					onBlur={() => setTouched(t => ({ ...t, displayName: true }))}
					aria-required="true"
					aria-invalid={showError('displayName') ? 'true' : undefined}
					aria-describedby={showError('displayName') ? 'f-name-err' : undefined}
				/>
				{showError('displayName')
					? <p className="field__error" id="f-name-err">{showError('displayName')}</p>
					: <p className="field__hint">Shown in lists and menus.</p>}
			</div>

			<div className="field">
				<label className="field__label" htmlFor="f-url">Endpoint URL</label>
				<input
					id="f-url"
					className="input"
					type="url"
					value={baseUrl}
					onChange={e => setBaseUrl(e.target.value)}
					onBlur={() => setTouched(t => ({ ...t, baseUrl: true }))}
					aria-required="true"
					aria-invalid={showError('baseUrl') ? 'true' : undefined}
					aria-describedby={showError('baseUrl') ? 'f-url-err' : undefined}
				/>
				{showError('baseUrl')
					? <p className="field__error" id="f-url-err">{showError('baseUrl')}</p>
					: <p className="field__hint">OpenAI-compatible base URL.</p>}
			</div>

			{!isNew && (
				<KeysEditor
					providerId={entry.id}
					keys={entry.keys}
					activeKeyId={entry.activeKeyId}
					onSaveKey={(keyId, label, value) => onSaveKey(entry.id, keyId, label, value)}
					onDeleteKey={keyId => onDeleteKey(entry.id, keyId)}
					onSetActiveKey={keyId => onSetActiveKey(entry.id, keyId)}
				/>
			)}

			<div className="field">
				<label className="field__label" htmlFor="f-models-url">Models URL</label>
				<input
					id="f-models-url"
					className="input"
					type="url"
					value={modelsUrl}
					onChange={e => setModelsUrl(e.target.value)}
					aria-describedby="f-models-url-hint"
				/>
				<p className="field__hint" id="f-models-url-hint">
					Where the model list is fetched from. Uses the active API key.
				</p>
				{!isNew && (
					<div className="models-fetch">
						<button
							type="button"
							className="btn"
							disabled={modelsFetch?.pending === true}
							title={modelsFetch?.pending ? 'Fetching…' : undefined}
							onClick={() => onFetchModels(entry.id, `req_${Date.now().toString(36)}`)}
						>
							{modelsFetch?.pending ? 'Fetching…' : 'Fetch models from API'}
						</button>
						{modelsFetch?.error && <p className="field__error">{modelsFetch.error}</p>}
						{fetchedModels && (
							<div className="model-pick">
								<div className="model-pick__head">
									<span className="field__hint">{fetchedModels.length} available — pick the ones to add:</span>
									<button
										type="button"
										className="btn btn--ghost"
										onClick={() => setFetchedModels(null)}
									>
										Dismiss
									</button>
								</div>
								<ul className="model-pick__list">
									{fetchedModels.map(id => (
										<li key={id}>
											<label className="check">
												<input
													type="checkbox"
													checked={selected.has(id)}
													onChange={() => toggleSelected(id)}
												/>
												{models.some(m => m.id === id) ? `${id} (already added)` : id}
											</label>
										</li>
									))}
								</ul>
								<button
									type="button"
									className="btn btn--primary"
									disabled={selected.size === 0}
									title={selected.size === 0 ? 'Select at least one model' : undefined}
									onClick={addSelectedModels}
								>
									Add {selected.size > 0 ? `${selected.size} ` : ''}selected
								</button>
							</div>
						)}
					</div>
				)}
			</div>

			<ModelListEditor
				models={models}
				onChange={setModels}
				supportedResponseTypes={entry.supportedResponseTypes ?? ['chat-completion']}
				supportedResponseFormats={entry.supportedResponseFormats ?? ['text']}
				infoPending={infoPending}
				infoErrors={infoErrors}
				onAutoFill={autoFillInfo}
			/>

			{models.length > 0 && (
				<div className="field">
					<label className="field__label" htmlFor="f-default">Default model</label>
					<select
						id="f-default"
						className="input"
						value={models.some(m => m.id === defaultModel) ? defaultModel : models[0].id}
						onChange={e => setDefaultModel(e.target.value)}
					>
						{models.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}
					</select>
				</div>
			)}

			<div className="form-actions">
				<button type="submit" className="btn btn--primary">Save</button>
				<button type="button" className="btn" onClick={onCancel}>Close</button>
			</div>
		</form>
	);
}
