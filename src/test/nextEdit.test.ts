import * as assert from 'assert';
import { applyNextEdits, parseNextEdits } from '../completion/nextEditPrompt';

suite('Next edit prompt', () => {
	test('parses and applies unique exact replacements', () => {
		const original = 'const answer = 1;\nconsole.log(answer);';
		const edits = parseNextEdits('{"edits":[{"oldText":"answer = 1","newText":"answer = 42"}]}', original);
		assert.deepStrictEqual(edits, [{ oldText: 'answer = 1', newText: 'answer = 42' }]);
		assert.strictEqual(applyNextEdits(original, edits!), 'const answer = 42;\nconsole.log(answer);');
	});

	test('rejects edits that cannot be safely located', () => {
		assert.strictEqual(parseNextEdits('{"edits":[{"oldText":"missing","newText":"value"}]}', 'const x = 1;'), undefined);
		assert.strictEqual(parseNextEdits('{"edits":[{"oldText":"x","newText":"y"}]}', 'x + x'), undefined);
	});
});
