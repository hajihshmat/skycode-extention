import { ProviderAdapter } from './adapters/providerAdapter';
import { OllamaAdapter } from './adapters/ollamaAdapter';
import { OpenAIAdapter } from './adapters/openaiAdapter';
import { AnthropicAdapter } from './adapters/anthropicAdapter';

/** Maps adapter type → factory. Built-ins register here; custom providers later too. */
const factories = new Map<string, () => ProviderAdapter>([
	['ollama', () => new OllamaAdapter()],
	['openai', () => new OpenAIAdapter()],
	['anthropic', () => new AnthropicAdapter()]
]);

export function getAdapter(type: string): ProviderAdapter {
	const factory = factories.get(type);
	if (!factory) {
		throw new Error(`No provider adapter registered for type "${type}"`);
	}
	return factory();
}

export function listAdapterTypes(): string[] {
	return [...factories.keys()];
}
