import { useMemo, useState } from 'react';
import { Check, Search } from 'lucide-react';
import type { ChatTarget } from './ChatView';

interface ModelSelectorPopoverProps {
	targets: ChatTarget[];
	current?: ChatTarget;
	onSelect: (t: ChatTarget) => void;
	onClose: () => void;
}

/**
 * Small dropdown (popover) that lists models grouped by provider.
 * Positioned by its parent (above the Model toolbar button) and closed on
 * outside-click by the parent's mousedown handler.
 */
export function ModelSelectorPopover({ targets, current, onSelect, onClose }: ModelSelectorPopoverProps) {
	const [query, setQuery] = useState('');

	const groups = useMemo(() => {
		const q = query.trim().toLowerCase();
		const filtered = targets.filter(
			t => !q || t.model.toLowerCase().includes(q) || t.displayName.toLowerCase().includes(q)
		);
		const byProvider = new Map<string, ChatTarget[]>();
		for (const t of filtered) {
			const list = byProvider.get(t.displayName) ?? [];
			list.push(t);
			byProvider.set(t.displayName, list);
		}
		return [...byProvider].map(([name, items]) => ({ name, items }));
	}, [targets, query]);

	return (
		<div
			role="menu"
			aria-label="Select a model"
			className="model-popover"
		>
			{/* Search */}
			<div className="model-popover__search-wrap">
				<div className="model-popover__search">
					<Search className="model-popover__search-icon" />
					<input
						autoFocus
						value={query}
						onChange={e => setQuery(e.target.value)}
						placeholder="Search models..."
						onKeyDown={e => e.stopPropagation()}
						className="model-popover__input"
					/>
				</div>
			</div>

			{/* Grouped list */}
			<div className="model-popover__list">
				{groups.map(g => (
					<div key={g.name}>
						<div className="model-popover__group">
							{g.name}
						</div>
						{g.items.map(t => {
							const active = current?.id === t.id && current?.model === t.model;
							return (
								<button
									key={`${t.id}::${t.model}`}
									type="button"
									role="menuitem"
									onClick={() => {
										onSelect(t);
										onClose();
									}}
									className="model-popover__option"
								>
									<span className="truncate font-mono">{t.model}</span>
									{active ? (
										<Check className="model-popover__check" aria-hidden="true" />
									) : (
										<span className="model-popover__check-space" aria-hidden="true" />
									)}
								</button>
							);
						})}
					</div>
				))}
				{groups.length === 0 && (
					<div className="model-popover__empty">
						No models found
					</div>
				)}
			</div>
		</div>
	);
}
