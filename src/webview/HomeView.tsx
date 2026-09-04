import { ProviderSettingsEntry } from '../settings/types';

interface HomeViewProps {
	providers: ProviderSettingsEntry[];
	onOpenSettings: () => void;
}

export function HomeView({ providers, onOpenSettings }: HomeViewProps) {
	return (
		<div className="page">
			<h1 className="heading">SkyCode AI</h1>
			{providers.length === 0 ? (
				<div className="empty-state">
					<span className="empty-state__icon" aria-hidden="true">◇</span>
					<p className="empty-state__text">No provider is configured yet.</p>
					<button className="btn btn--primary" onClick={onOpenSettings}>
						Add a provider
					</button>
				</div>
			) : (
				<>
					<ul className="provider-list">
						{providers.map(p => (
							<li key={p.id} className="provider-row">
								<span className="provider-row__name">{p.displayName}</span>
								<span className={p.hasApiKey ? 'dot dot--ok' : 'dot dot--warn'} aria-hidden="true" />
							</li>
						))}
					</ul>
					<button className="btn" onClick={onOpenSettings}>
						Manage providers
					</button>
				</>
			)}
		</div>
	);
}
