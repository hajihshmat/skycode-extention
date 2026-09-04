import { ChatError } from '../types';

/** Fetch wrapper that preserves a useful, secret-free network failure reason. */
export async function request(url: string, init: RequestInit): Promise<Response> {
	try {
		return await fetch(url, init);
	} catch (error) {
		if (init.signal?.aborted) {
			throw error;
		}
		throw new ChatError('network', networkFailureMessage(url, error));
	}
}

export function networkFailureMessage(url: string, error: unknown): string {
	const detail = rootErrorDetail(error);
	return `Network request to ${url} failed${detail ? ` (${detail})` : ''}. Check the provider endpoint, DNS, proxy, or local server.`;
}

function rootErrorDetail(error: unknown): string | undefined {
	let current = error;
	for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth++) {
		const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
		if (typeof candidate.code === 'string') {
			return candidate.code;
		}
		if (typeof candidate.cause === 'object' && candidate.cause) {
			current = candidate.cause;
			continue;
		}
		if (typeof candidate.message === 'string' && candidate.message !== 'fetch failed') {
			return candidate.message;
		}
		break;
	}
	return undefined;
}
