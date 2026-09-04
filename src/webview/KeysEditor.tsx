import { useState } from 'react';
import { KeyEntry } from '../settings/types';

interface KeysEditorProps {
	providerId: string;
	keys: KeyEntry[];
	activeKeyId?: string;
	/** Only persisted providers can hold keys — new ones must be saved first. */
	onSaveKey: (keyId: string, label: string, value?: string) => void;
	onDeleteKey: (keyId: string) => void;
	onSetActiveKey: (keyId: string) => void;
}

/**
 * Multi-key editor for one provider instance. Secrets stay in SecretStorage;
 * this UI only reads/writes labels and triggers host-side operations.
 */
export function KeysEditor({
	providerId,
	keys,
	activeKeyId,
	onSaveKey,
	onDeleteKey,
	onSetActiveKey
}: KeysEditorProps) {
	const [newLabel, setNewLabel] = useState('');
	const [newValue, setNewValue] = useState('');
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editLabel, setEditLabel] = useState('');
	const [editValue, setEditValue] = useState('');
	const [open, setOpen] = useState(false);

	const canPersist = providerId !== '';

	const addKey = () => {
		if (!newLabel.trim() || !newValue.trim()) {
			return;
		}
		onSaveKey('', newLabel.trim(), newValue.trim());
		setNewLabel('');
		setNewValue('');
	};

	return (
		<div className="field">
			<div className="keys-head">
				<span className="field__label">API keys</span>
				<button
					type="button"
					className="btn btn--ghost"
					onClick={() => setOpen(o => !o)}
					aria-expanded={open}
				>
					{open ? 'Hide' : 'Manage'}
				</button>
			</div>

			{keys.length === 0 ? (
				<p className="field__hint">No keys yet.</p>
			) : (
				<ul className="key-list">
					{keys.map(k => {
						const isActive = k.id === (activeKeyId ?? keys[0].id);
						const isEditing = editingId === k.id;
						return (
							<li key={k.id} className="key-row">
								{isEditing ? (
									<>
										<input
											className="input key-row__label"
											value={editLabel}
											onChange={e => setEditLabel(e.target.value)}
											aria-label="Key label"
										/>
										<input
											className="input key-row__value"
											type="password"
											value={editValue}
											placeholder="new secret (optional)"
											autoComplete="off"
											onChange={e => setEditValue(e.target.value)}
											aria-label="New secret value"
										/>
										<button
											type="button"
											className="btn btn--primary"
											onClick={() => {
												onSaveKey(k.id, editLabel.trim(), editValue.trim() || undefined);
												setEditingId(null);
												setEditValue('');
											}}
										>
											Save
										</button>
									</>
								) : (
									<>
										<label className="check" title="Use this key for requests">
											<input
												type="radio"
												name={`active-key-${providerId}`}
												checked={isActive}
												disabled={!canPersist}
												onChange={() => onSetActiveKey(k.id)}
											/>
											{k.label}
										</label>
										<div className="key-row__actions">
											<button
												type="button"
												className="btn btn--ghost"
												onClick={() => {
													setEditingId(k.id);
													setEditLabel(k.label);
													setEditValue('');
												}}
											>
												Edit
											</button>
											<button
												type="button"
												className="btn btn--danger"
												onClick={() => onDeleteKey(k.id)}
											>
												✕
											</button>
										</div>
									</>
								)}
							</li>
						);
					})}
				</ul>
			)}

			{open && canPersist && (
				<div className="key-add">
					<input
						className="input key-row__label"
						value={newLabel}
						placeholder="Label (e.g. personal)"
						onChange={e => setNewLabel(e.target.value)}
					/>
					<input
						className="input key-row__value"
						type="password"
						value={newValue}
						placeholder="Secret"
						autoComplete="off"
						onChange={e => setNewValue(e.target.value)}
					/>
					<button
						type="button"
						className="btn"
						onClick={addKey}
						disabled={!newLabel.trim() || !newValue.trim()}
						title={newLabel.trim() && newValue.trim() ? undefined : 'Label and secret are required'}
					>
						Add key
					</button>
				</div>
			)}
			{!canPersist && (
				<p className="field__hint">Save the provider once to be able to add keys.</p>
			)}
		</div>
	);
}
