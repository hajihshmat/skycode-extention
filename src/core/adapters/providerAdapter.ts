import { Capabilities, ChatRequestContext, ChatResponse, ChatStreamChunk, ModelEntity, ProviderEntity, ResponseFormat, ResponseType } from '../types';

/** Adapter-provided endpoint defaults (paths relative to baseUrl). */
export interface AdapterEndpointDefaults {
	/** Path used for chat when the provider config doesn't override it. */
	chatEndpoint: string;
	/** Path used for model discovery. */
	modelsEndpoint: string;
	/** Optional model-details endpoint (Ollama /api/show). */
	showEndpoint?: string;
}

/** Non-secret draft produced by model discovery. */
export interface ModelDraft {
	modelIdentifier: string;
	name?: string;
	contextWindow?: number;
	capabilities?: Capabilities;
	parameterSize?: string;
	quantizationLevel?: string;
}

/**
 * Provider-specific behaviour. Implementations must never be referenced
 * directly by the chat engine or the UI — always through the registry.
 */
export interface ProviderAdapter {
	readonly type: string;
	readonly displayName: string;
	readonly requiresCredentials: boolean;
	/** Response styles this adapter can handle; drives the Model Editor dropdown. */
	readonly supportedResponseTypes: ResponseType[];
	/** Output formats this adapter can enforce; drives the Model Editor dropdown. */
	readonly supportedResponseFormats: ResponseFormat[];
	resolveEndpoints(provider: ProviderEntity): { chat: string; models: string; show?: string };
	discoverModels(provider: ProviderEntity, apiKey?: string): Promise<ModelDraft[]>;
	sendChat(ctx: ChatRequestContext): Promise<ChatResponse>;
	/** OpenAI-style Responses API; only for adapters listing 'response' in supportedResponseTypes. */
	sendResponse?(ctx: ChatRequestContext): Promise<ChatResponse>;
	/** Optional SSE streaming variant of sendResponse (Responses API event stream). */
	sendResponseStream?(ctx: ChatRequestContext): AsyncIterable<ChatStreamChunk>;
	/** Optional SSE streaming chat; errors before the first chunk participate in credential rotation. */
	sendChatStream?(ctx: ChatRequestContext): AsyncIterable<ChatStreamChunk>;
	showModelInfo?(provider: ProviderEntity, modelIdentifier: string, apiKey?: string): Promise<Partial<ModelEntity>>;
	testConnection?(provider: ProviderEntity, apiKey?: string): Promise<void>;
}
