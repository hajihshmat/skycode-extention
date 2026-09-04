import { DEFAULT_RESPONSE_FORMAT, DEFAULT_RESPONSE_TYPE, ModelEntity, ProviderEntity, ResolvedModel } from './types';

/** Merge API-discovered values with user overrides (overrides win). */
export function resolveModel(model: ModelEntity): ResolvedModel {
	const api = model.apiValues ?? {};
	const ov = model.overrides ?? {};
	return {
		id: model.id,
		modelIdentifier: model.modelIdentifier,
		name: ov.name ?? model.name,
		contextWindow: ov.contextWindow ?? api.contextWindow,
		maxOutputTokens: ov.maxOutputTokens ?? api.maxOutputTokens,
		endpointOverride: ov.endpoint ?? model.endpointOverride,
		capabilities: { ...(api.capabilities ?? {}), ...(ov.capabilities ?? {}) },
		responseType: ov.responseType ?? DEFAULT_RESPONSE_TYPE,
		responseFormat: ov.responseFormat ?? DEFAULT_RESPONSE_FORMAT
	};
}

/** Join a base URL and a path/absolute URL. */
export function joinUrl(base: string, pathOrUrl: string): string {
	if (/^https?:\/\//i.test(pathOrUrl)) {
		return pathOrUrl;
	}
	const b = base.replace(/\/+$/, '');
	return `${b}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
}

export interface ResolvedEndpoints {
	chat: string;
	models: string;
	show?: string;
}

/** Minimal provider surface the resolver needs. */
export type EndpointSource = Pick<ProviderEntity, 'baseUrl' | 'chatEndpoint' | 'modelsUrl'> & {
	endpointOverride?: string;
};

/**
 * Endpoint resolution order:
 * model endpoint override → provider chatEndpoint/modelUrl → adapter default.
 */
export function resolveEndpoint(
	provider: EndpointSource,
	defaultEndpoint: string,
	kind: 'chat' | 'models'
): string {
	const base = (provider.baseUrl || '').replace(/\/+$/, '');
	const configured = kind === 'chat'
		? (provider.endpointOverride ?? provider.chatEndpoint ?? defaultEndpoint)
		: (provider.modelsUrl ?? defaultEndpoint);
	return joinUrl(base, configured);
}
