import * as assert from 'assert';
import { CHAT_MODES, buildRequestMessages, getChatMode } from '../webview/chatModes';

suite('Chat composer modes', () => {
	test('exposes chat, agent and plan in display order', () => {
		assert.deepStrictEqual(CHAT_MODES.map(m => m.id), ['chat', 'agent', 'plan']);
		for (const mode of CHAT_MODES) {
			assert.ok(mode.label.length > 0, `${mode.id} needs a label`);
			assert.ok(mode.placeholder.length > 0, `${mode.id} needs a placeholder`);
		}
	});

	test('falls back to chat for an unknown id', () => {
		assert.strictEqual(getChatMode('nope' as never).id, 'chat');
	});

	test('chat mode sends the transcript unchanged', () => {
		const history = [
			{ role: 'user' as const, content: 'hi' },
			{ role: 'assistant' as const, content: 'hello' }
		];
		assert.deepStrictEqual(buildRequestMessages('chat', history, 'next'), [
			...history,
			{ role: 'user', content: 'next' }
		]);
	});

	test('agent and plan prepend exactly one system directive', () => {
		for (const id of ['agent', 'plan'] as const) {
			const messages = buildRequestMessages(id, [{ role: 'user', content: 'hi' }], 'go');
			assert.strictEqual(messages.filter(m => m.role === 'system').length, 1);
			assert.strictEqual(messages[0].role, 'system');
			assert.strictEqual(messages[0].content, getChatMode(id).directive);
			assert.deepStrictEqual(messages[messages.length - 1], { role: 'user', content: 'go' });
		}
	});

	test('plan mode forbids workspace mutations in its directive', () => {
		const directive = getChatMode('plan').directive ?? '';
		assert.match(directive, /never create, edit, delete, or run/);
	});
});
