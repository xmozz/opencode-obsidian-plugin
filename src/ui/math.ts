/** Pure helpers for math detection in chat text. No Obsidian imports (unit-testable). */

/** Avoids turning prices ("costs $5 and $10") into math. */
export function isPlausibleInlineMath(
	text: string,
	dollarIndex: number,
	content: string,
): boolean {
	if (!content || /^\s|\s$/.test(content)) return false;
	if (dollarIndex > 0 && /[0-9A-Za-z]/.test(text[dollarIndex - 1] ?? "")) return false;
	return true;
}

/** Known LaTeX commands — a code span containing one is almost surely math. */
const LATEX_CMD =
	/\\(frac|d?frac|tfrac|cfrac|cdot|cdots|ldots|vdots|ddots|sum|prod|coprod|int|iint|iiint|oint|sqrt|geq|ge|leq|le|neq|ne|approx|cong|equiv|sim|simeq|times|div|pm|mp|infty|in|notin|ni|forall|exists|nexists|subset|supset|subseteq|supseteq|cap|cup|vee|wedge|neg|left|right|big|Big|bigg|Bigg|langle|rangle|lfloor|rfloor|lceil|rceil|overline|underline|hat|tilde|bar|vec|dot|ddot|mathrm|mathbf|mathit|mathsf|mathtt|mathcal|mathbb|text|quad|qquad|to|gets|rightarrow|leftarrow|Rightarrow|Leftarrow|leftrightarrow|mapsto|alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|pi|varpi|rho|varrho|sigma|varsigma|tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega|partial|nabla|angle|perp|parallel|propto|checkmark|binom|lim|log|ln|exp|sin|cos|tan|min|max|sup|inf|det|gcd)(?![A-Za-z])/;

export function looksLikeLatex(s: string): boolean {
	return LATEX_CMD.test(s);
}

/** True for ```latex / ```tex / ```math fences. */
export function isLatexFence(fence: string): boolean {
	return /^```\s*(latex|tex|math)\b/i.test(fence);
}

/** Removes the opening (```lang) and closing (```) fence lines. */
export function stripFence(fence: string): string {
	const lines = fence.split("\n");
	if (/^```/.test(lines[0] ?? "")) lines.shift();
	while (lines.length > 0 && /^```\s*$/.test(lines[lines.length - 1] ?? "")) lines.pop();
	return lines.join("\n");
}

const TOKEN =
	/(```[\s\S]*?```)|(`[^`\n]+`)|\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;

/**
 * Rewrites code spans/blocks that actually contain LaTeX into $…$/$$…$$
 * math, so a full Markdown renderer typesets them. Everything else
 * (including plain-ASCII formulas and real code) is left untouched.
 */
export function convertLatexCodeToMath(text: string): string {
	let out = "";
	let last = 0;
	let match: RegExpExecArray | null;
	TOKEN.lastIndex = 0;
	while ((match = TOKEN.exec(text)) !== null) {
		const [full, fence, inlineCode] = match;
		out += text.slice(last, match.index);
		if (fence) {
			const inner = stripFence(full);
			if (isLatexFence(full) || looksLikeLatex(inner)) {
				out += /\$\$/.test(inner) ? inner : `$$\n${inner}\n$$`;
			} else {
				out += full;
			}
		} else if (inlineCode) {
			const inner = full.slice(1, -1);
			out += looksLikeLatex(inner) ? `$${inner}$` : full;
		} else {
			out += full;
		}
		last = match.index + full.length;
	}
	out += text.slice(last);
	return out;
}
