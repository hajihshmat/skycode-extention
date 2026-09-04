import { CredentialMeta } from './types';

export type CredentialStrategy = 'failover' | 'round-robin' | 'random' | 'lru';

const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * Owns credential selection and rotation policy. Chat engines ask for the
 * next available credential and report outcomes back — they never implement
 * rotation themselves. Only 'failover' is implemented; others are extension
 * points.
 */
export class CredentialManager {
	constructor(
		private metas: CredentialMeta[],
		public readonly strategy: CredentialStrategy = 'failover'
	) {}

	get all(): CredentialMeta[] {
		return this.metas;
	}

	/**
	 * First enabled credential that is active or out of cooldown.
	 * The provider's `activeCredentialId` (user's preferred choice) is tried
	 * first when provided, enabled and not in cooldown; otherwise the first
	 * available credential is returned (standard failover).
	 */
	getAvailableCredential(preferredId?: string): CredentialMeta | undefined {
		const now = Date.now();
		const isAvailable = (c: CredentialMeta) =>
			c.enabled &&
			(c.status === 'active' || (c.status === 'rate-limited' && (c.cooldownUntil ?? 0) <= now));
		if (preferredId) {
			const preferred = this.metas.find(c => c.id === preferredId);
			if (preferred && isAvailable(preferred)) {
				return preferred;
			}
		}
		return this.metas.find(isAvailable);
	}

	markRateLimited(id: string, retryAfterSec?: number): void {
		const c = this.metas.find(m => m.id === id);
		if (c) {
			c.status = 'rate-limited';
			c.cooldownUntil = Date.now() + (retryAfterSec && retryAfterSec > 0 ? retryAfterSec * 1000 : DEFAULT_COOLDOWN_MS);
		}
	}

	markInvalid(id: string): void {
		const c = this.metas.find(m => m.id === id);
		if (c) {
			c.status = 'invalid';
			c.cooldownUntil = undefined;
		}
	}

	markSuccessful(id: string): void {
		const c = this.metas.find(m => m.id === id);
		if (c) {
			c.status = 'active';
			c.cooldownUntil = undefined;
		}
	}

	/** Explicit switch to the next enabled credential (extension point). */
	rotateCredential(): CredentialMeta | undefined {
		return this.getAvailableCredential();
	}
}
