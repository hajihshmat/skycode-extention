import { ModelEntry } from '../settings/types';
import type { ModelSource, ResponseFormat, ResponseType } from '../core/types';

interface ModelListEditorProps {
	models: ModelEntry[];
	onChange: (models: ModelEntry[]) => void;
	/** Response styles the provider's adapter supports (filters the dropdown). */
	supportedResponseTypes: ResponseType[];
	/** Output formats the provider's adapter supports (filters the dropdown). */
	supportedResponseFormats: ResponseFormat[];
	/** Model ids currently being auto-filled from /api/show. */
	infoPending?: Set<string>;
	infoErrors?: Record<string, string>;
	onAutoFill?: (modelId: string) => void;
}

const RESPONSE_TYPE_LABELS: Record<ResponseType, string> = {
	'chat-completion': 'Chat Completions',
	'response': 'Responses API'
};

const RESPONSE_FORMAT_LABELS: Record<ResponseFormat, string> = {
	'text': 'Text',
	'json_object': 'JSON Object'
};

/**
 * Per-model capability editor: id, context window, streaming, vision, tools.
 * Rows are added manually, selected from an API fetch, or auto-filled from
 * Ollama's /api/show.
 */
export function ModelListEditor({
	models,
	onChange,
	supportedResponseTypes,
	supportedResponseFormats,
	infoPending,
	infoErrors,
	onAutoFill
}: ModelListEditorProps) {
	const update = (index: number, patch: Partial<ModelEntry>) => {
		onChange(models.map((m, i) => (i === index ? { ...m, ...patch } : m)));
	};
	const remove = (index: number) => onChange(models.filter((_, i) => i !== index));
	const addApi = () => onChange([...models, { id: '', source: 'api', supportsStreaming: true }]);
	const addManual = () => onChange([...models, { id: '', source: 'manual' }]);
	const autoFill = (id: string) => {
		if (id && onAutoFill) {
			onAutoFill(id);
		}
	};

	return (
		<div className="field">
			<span className="field__label">Models</span>
			{models.length === 0 && (
				<p className="field__hint">No models. Add one manually or fetch the list from the API.</p>
			)}
			{models.map((m, i) => {
				const pending = infoPending?.has(m.id) ?? false;
				const error = m.id ? infoErrors?.[m.id] : undefined;
				return (
					<div key={i} className="model-row">
						<div className="model-row__main">
							<input
								className="input model-row__id"
								value={m.id}
								placeholder="model-id"
								aria-label="Model id"
								onChange={e => update(i, { id: e.target.value })}
							/>
							<span className="model-row__badges">
								<span
									className={`badge badge--source badge--${m.source ?? 'api'}`}
									title={m.source === 'manual' ? 'Manually added model' : 'Discovered model â€” refreshable from the API'}
								>
									{m.source === 'manual' ? 'âœï¸ Manual' : 'ðŸ”„ API'}
								</span>
								{m.parameterSize && <span className="badge">{m.parameterSize}</span>}
								{m.quantizationLevel && <span className="badge">{m.quantizationLevel}</span>}
							</span>
							<input
								className="input model-row__endpoint"
								value={m.endpoint ?? ''}
								placeholder="Custom endpoint (optional)"
								aria-label={`Custom endpoint for ${m.id || 'model'}`}
								onChange={e => update(i, { endpoint: e.target.value })}
							/>
						</div>
						<input
							className="input model-row__ctx"
							type="number"
							min={0}
							value={m.contextLength ?? ''}
							placeholder="Context"
							aria-label={`Context length for ${m.id || 'model'}`}
							onChange={e => update(i, { contextLength: e.target.value ? Number(e.target.value) : undefined })}
						/>
						<select
							className="input model-row__rt"
							aria-label={`Response type for ${m.id || 'model'}`}
							title="Request/response style"
							value={m.responseType ?? 'chat-completion'}
							onChange={e => update(i, { responseType: e.target.value as ResponseType })}
						>
							{supportedResponseTypes.map(rt => (
								<option key={rt} value={rt}>{RESPONSE_TYPE_LABELS[rt] ?? rt}</option>
							))}
						</select>
						<select
							className="input model-row__rf"
							aria-label={`Response format for ${m.id || 'model'}`}
							title="Output format"
							value={m.responseFormat ?? 'text'}
							onChange={e => update(i, { responseFormat: e.target.value as ResponseFormat })}
						>
							{supportedResponseFormats.map(rf => (
								<option key={rf} value={rf}>{RESPONSE_FORMAT_LABELS[rf] ?? rf}</option>
							))}
						</select>
						<label className="check" title="Streaming supported">
							<input
								type="checkbox"
								checked={m.supportsStreaming ?? false}
								onChange={e => update(i, { supportsStreaming: e.target.checked })}
							/>
							stream
						</label>
						<label className="check" title="Vision (image input) supported">
							<input
								type="checkbox"
								checked={m.supportsVision ?? false}
								onChange={e => update(i, { supportsVision: e.target.checked })}
							/>
							vision
						</label>
						<label className="check" title="Tool/function calling supported">
							<input
								type="checkbox"
								checked={m.supportsTools ?? false}
								onChange={e => update(i, { supportsTools: e.target.checked })}
							/>
							tools
						</label>
						<button
							type="button"
							className="btn btn--ghost model-row__auto"
							disabled={!m.id || pending}
							title={!m.id ? 'Enter a model id first' : pending ? 'Fetchingâ€¦' : 'Auto-fill from Ollama /api/show'}
							onClick={() => autoFill(m.id)}
						>
							{pending ? 'â€¦' : 'Auto'}
						</button>
						<button
							type="button"
							className="btn btn--danger model-row__remove"
							onClick={() => remove(i)}
							aria-label={`Remove model ${m.id || i + 1}`}
						>
							âœ•
						</button>
						{error && <p className="field__error model-row__error">{error}</p>}
					</div>
				);
			})}
			<div className="model-actions">
				<button type="button" className="btn" onClick={addApi}>Add model</button>
				<button type="button" className="btn btn--ghost" onClick={addManual}>+ Add Manual Model</button>
			</div>
		</div>
	);
}

/** Merge fetched ids into the current list without clobbering capabilities. */
export function mergeFetchedModels(current: ModelEntry[], fetched: string[]): ModelEntry[] {
	const known = new Set(current.map(m => m.id));
	const additions = fetched
		.filter(id => id && !known.has(id))
		.map(id => ({ id, source: 'api' as const, supportsStreaming: true }));
	return [...current, ...additions];
}
