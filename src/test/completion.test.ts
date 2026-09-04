import * as assert from 'assert';
import { buildCompletionPrompt, cleanCompletion } from '../completion/completionPrompt';

suite('Auto suggestion prompt', () => {
	test('keeps the model response insertion-safe', () => {
		assert.strictEqual(cleanCompletion('```ts\nvalue);\n```', 'value('), 'value);');
		assert.strictEqual(cleanCompletion('value(foo)', 'value('), 'foo)');
		assert.strictEqual(cleanCompletion('', 'value('), undefined);
	});

	test('includes indexed symbols and cursor context', () => {
		const prompt = buildCompletionPrompt({
			languageId: 'typescript',
			fileName: 'src/example.ts',
			linePrefix: 'return user.',
			lineSuffix: '',
			nearbyCode: 'function formatUser(user: User) {\n  return user.\n}',
			imports: ["import { User } from './types';"],
			symbols: ['function formatUser']
		});
		assert.ok(prompt.includes('function formatUser'));
		assert.ok(prompt.includes('BEFORE_CURSOR: return user.'));
		assert.ok(prompt.includes('Return only the code to insert at the cursor'));
	});
});
