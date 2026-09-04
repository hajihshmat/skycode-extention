/**
 * Detect the reading direction of message content.
 *
 * The whole extension is LTR-first; we only flip a single message to RTL when a
 * meaningful share of its non-whitespace characters come from right-to-left
 * scripts (Persian, Arabic, Hebrew, …). The threshold is deliberately
 * conservative so code-heavy strings with a little Persian still read as RTL.
 */
export function detectDirection(text: string): 'ltr' | 'rtl' {
	const rtlRegex = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
	const rtlChars = (text.match(rtlRegex) || []).length;
	const totalChars = text.replace(/\s/g, '').length;
	return totalChars > 0 && rtlChars / totalChars > 0.3 ? 'rtl' : 'ltr';
}