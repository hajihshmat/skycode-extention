import * as assert from 'assert';
import { extractJson, parseAgentResponse, stripThinking } from '../tools/chatToolAgent';
import { CHAT_MODES, buildRequestMessages, getChatMode } from '../webview/chatModes';

suite('Chat tool agent response parsing', () => {
	test('parses a clean tool call', () => {
		const action = parseAgentResponse('{"type":"tool","name":"read-file","arguments":{"path":"src/a.ts"}}');
		assert.deepStrictEqual(action, { type: 'tool', name: 'read-file', arguments: { path: 'src/a.ts' } });
	});

	test('parses a clean final reply', () => {
		const action = parseAgentResponse('{"type":"final","content":"All done."}');
		assert.deepStrictEqual(action, { type: 'final', content: 'All done.' });
	});

	test('accepts tool calls that omit the "type" field', () => {
		const action = parseAgentResponse('{"tool":"check-workspace","arguments":{}}');
		assert.ok(action && action.type === 'tool' && action.name === 'check-workspace');
	});

	test('extracts JSON wrapped in prose and code fences', () => {
		const raw = 'Sure! Here is the call:\n```json\n{"type":"final","content":"hi"}\n```';
		assert.deepStrictEqual(parseAgentResponse(raw), { type: 'final', content: 'hi' });
	});

	test('strips reasoning-model <think> blocks', () => {
		const raw = '<think>Let me plan… {"fake":"json"}</think>{"type":"final","content":"answer"}';
		assert.strictEqual(stripThinking(raw), '{"type":"final","content":"answer"}');
		assert.deepStrictEqual(parseAgentResponse(raw), { type: 'final', content: 'answer' });
	});

	test('extracts the first balanced object even with braces in strings', () => {
		const raw = 'note { "a": "has } brace", "b": 1 } trailing';
		assert.strictEqual(extractJson(raw), '{ "a": "has } brace", "b": 1 }');
	});

	test('returns undefined for prose without JSON or an unterminated object', () => {
		assert.strictEqual(parseAgentResponse('I will now read the file.'), undefined);
		assert.strictEqual(parseAgentResponse('{"type":"final","content":"cut'), undefined);
	});

	test('rejects unknown tool names', () => {
		const action = parseAgentResponse('{"type":"tool","name":"format-disk","arguments":{}}');
		assert.strictEqual(action, undefined);
	});
});
