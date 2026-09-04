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
			className="absolute bottom-full left-0 z-[1000] mb-2 w-72 overflow-hidden rounded-lg border border-[var(--vscode-dropdown-border)] bg-[var(--vscode-dropdown-background)] shadow-lg"
		>
			{/* Search */}
			<div className="px-2 pb-1 pt-2">
				<div className="relative">
					<Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--vscode-descriptionForeground)]" />
					<input
						autoFocus
						value={query}
						onChange={e => setQuery(e.target.value)}
						placeholder="Search models..."
						onKeyDown={e => e.stopPropagation()}
						className="w-full rounded-md border border-[var(--vscode-input-border)] bg-[var(--vscode-input-background)] py-1.5 pl-7 pr-2 text-xs text-[var(--vscode-input-foreground)] placeholder:text-[var(--vscode-descriptionForeground)] focus:outline-none focus:ring-1 focus:ring-[var(--vscode-focusBorder)]"
					/>
				</div>
			</div>

			{/* Grouped list */}
			<div className="max-h-64 overflow-y-auto px-1 pb-1.5">
				{groups.map(g => (
					<div key={g.name}>
						<div className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--vscode-descriptionForeground)]">
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
									className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs text-[var(--vscode-foreground)] transition-colors hover:bg-[var(--vscode-list-hoverBackground)]"
								>
									<span className="truncate font-mono">{t.model}</span>
									{active ? (
										<Check className="h-3.5 w-3.5 shrink-0 text-[var(--vscode-button-background)]" />
									) : (
										<span className="h-3.5 w-3.5 shrink-0" />
									)}
								</button>
							);
						})}
					</div>
				))}
				{groups.length === 0 && (
					<div className="px-3 py-6 text-center text-xs text-[var(--vscode-descriptionForeground)]">
						No models found
					</div>
				)}
			</div>
		</div>
	);
}