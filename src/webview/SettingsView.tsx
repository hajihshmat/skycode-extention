import { FormEvent, useMemo, useState } from 'react';
import { PROVIDER_CATALOG, ModelInfoFetchedMessage, ProviderSettingsEntry, ProviderTypeId } from '../settings/types';
import { ProviderForm, SavePayload, ModelsFetchState } from './ProviderForm';
import { KeyOps } from './keyOps';

import type { ResponseFormat, ResponseType } from '../core/types';

export type { SavePayload };

interface SettingsViewProps extends KeyOps {
	providers: ProviderSettingsEntry[];
	modelsFetch: ModelsFetchState | null;
	modelInfoResults: ModelInfoFetchedMessage[];
	onClose: () => void;
	onSave: (payload: SavePayload) => void;
	onDelete: (id: string) => void;
}

/** Blank form state for a new provider of the given type. */
const RESPONSE_TYPES_BY_PROVIDER: Record<ProviderTypeId, ResponseType[]> = {
	ollamaCloud: ['chat-completion'],
	openai: ['chat-completion', 'response'],
	anthropic: ['chat-completion'],
	'openai-compatible': ['chat-completion', 'response']
};

const RESPONSE_FORMATS_BY_PROVIDER: Record<ProviderTypeId, ResponseFormat[]> = {
	ollamaCloud: ['text', 'json_object'],
	openai: ['text', 'json_object'],
	anthropic: ['text'],
	'openai-compatible': ['text', 'json_object']
};

function blankEntry(providerId: ProviderTypeId): ProviderSettingsEntry {
	const catalog = PROVIDER_CATALOG.find(p => p.providerId === providerId)!;
	return {
		id: '',
		providerId,
		displayName: catalog.displayName,
		baseUrl: catalog.defaultBaseUrl,
		models: [],
		keys: [],
		hasApiKey: false,
		supportedResponseTypes: RESPONSE_TYPES_BY_PROVIDER[providerId],
		supportedResponseFormats: RESPONSE_FORMATS_BY_PROVIDER[providerId]
	};
}

const urlPattern = /^https?:\/\/\S+$/;

export function SettingsView({
	providers,
	modelsFetch,
	modelInfoResults,
	onClose,
	onSave,
	onDelete,
	onSaveKey,
	onDeleteKey,
	onSetActiveKey,
	onFetchModels,
	onFetchModelInfo,
	onConsumeInfoResults
}: SettingsViewProps) {
	const [editing, setEditing] = useState<ProviderSettingsEntry | null>(null);
	const isNew = editing !== null && editing.id === '';

	if (editing) {
		return (
			<ProviderForm
				entry={editing}
				isNew={isNew}
				modelsFetch={modelsFetch}
				modelInfoResults={modelInfoResults}
				onCancel={() => setEditing(null)}
				onSave={payload => {
					onSave(payload);
					setEditing(null);
				}}
				onSaveKey={onSaveKey}
				onDeleteKey={onDeleteKey}
				onSetActiveKey={onSetActiveKey}
				onFetchModels={onFetchModels}
				onFetchModelInfo={onFetchModelInfo}
				onConsumeInfoResults={onConsumeInfoResults}
			/>
		);
	}

	return (
		<div className="page">
			<div className="page-header">
				<h1 className="heading">Settings</h1>
				<button className="btn btn--ghost" onClick={onClose} aria-label="Back">
					Back
				</button>
			</div>

			<h2 className="section-label">Providers</h2>
			{providers.length === 0 ? (
				<p className="hint">No providers yet. Add one to start using AI features.</p>
			) : (
				<ul className="provider-list">
					{providers.map(p => (
						<li key={p.id} className="provider-card">
							<div className="provider-card__head">
								<span className="provider-card__name">{p.displayName}</span>
								<div className="provider-card__actions">
									<button className="btn btn--ghost" onClick={() => setEditing({ ...p })}>
										Edit
									</button>
									<button className="btn btn--danger" onClick={() => onDelete(p.id)}>
										Remove
									</button>
								</div>
							</div>
							<dl className="provider-card__meta">
								<div className="meta-row"><dt>Endpoint</dt><dd>{p.baseUrl}</dd></div>
								<div className="meta-row">
									<dt>Models</dt>
									<dd>{p.models.length > 0 ? p.models.map(m => m.id).join(', ') : '—'}</dd>
								</div>
								<div className="meta-row"><dt>Default</dt><dd>{p.defaultModel ?? '—'}</dd></div>
								<div className="meta-row">
									<dt>Keys</dt>
									<dd>{p.keys.length > 0 ? `${p.keys.length} key${p.keys.length > 1 ? 's' : ''}` : 'None'}</dd>
								</div>
							</dl>
						</li>
					))}
				</ul>
			)}

			<button className="btn btn--primary" onClick={() => setEditing(blankEntry('ollamaCloud'))}>
				Add provider
			</button>
		</div>
	);
}
