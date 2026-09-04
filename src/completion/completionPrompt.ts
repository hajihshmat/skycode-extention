import type { CodeContext } from './contextIndexer';

const MAX_COMPLETION_CHARS = 1_800;

/** A strict contract: the completion is inserted directly at the cursor. */
export function buildCompletionPrompt(context: CodeContext): string {
	return [
		'You are an inline code completion engine.',
		`Return only the code to insert at the cursor in ${context.languageId}.`,
		'Do not use Markdown, code fences, explanations, headings, or quotes.',
		'Do not repeat text before the cursor. Continue the existing style and indentation.',
		'Prefer the smallest correct completion. Do not invent APIs, files, imports, or symbols.',
		`Return at most ${MAX_COMPLETION_CHARS} characters. Return an empty response when no safe completion is clear.`,
		'',
		`FILE: ${context.fileName}`,
		`IMPORTS:\n${formatList(context.imports)}`,
		`DECLARED SYMBOLS:\n${formatList(context.symbols)}`,
		'NEARBY CODE:',
		context.nearbyCode,
		'',
		'CURSOR LINE:',
		`BEFORE_CURSOR: ${context.linePrefix}`,
		`AFTER_CURSOR: ${context.lineSuffix}`,
		'COMPLETION:'
	].join('\n');
}

export function cleanCompletion(raw: string, linePrefix: string): string | undefined {
	let value = raw.trimEnd();
	value = value.replace(/^completion\s*:\s*/i, '');
	value = value.replace(/^```(?:\w+)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trimEnd();
	if (value.startsWith(linePrefix)) {
		value = value.slice(linePrefix.length);
	}
	if (!value || value.length > MAX_COMPLETION_CHARS) {
		return undefined;
	}
	return value;
}

function formatList(values: string[]): string {
	return values.length > 0 ? values.map(value => `- ${value}`).join('\n') : '(none)';
}
