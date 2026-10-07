/**
 * Plain-text validation for user-visible strings we put on the owner's phone.
 *
 * Text is NFC-normalized first (so composed letters such as Romanian ș/ț/ă count
 * as one character), then every character must be a letter, digit, punctuation,
 * a math/currency/modifier symbol, the degree sign, or a plain space; line
 * breaks only where allowed. Everything else is refused, never stripped:
 * emoji and pictographs, control and invisible format characters (zero-width
 * joiners, bidi overrides that make text display differently than it reads),
 * variation selectors and leftover combining marks ("zalgo"), private-use and
 * lone surrogates.
 */

const ALLOWED_CHAR = /^[\p{L}\p{N}\p{P}\p{Sm}\p{Sc}\p{Sk}° ]$/u;

export interface PlainTextOptions {
    field: string;
    maxLength: number;
    allowNewlines?: boolean;
}

/**
 * @returns the NFC-normalized text
 * @throws Error naming the field and the first offending character
 */
export function validatePlainText(text: string, options: PlainTextOptions): string {
    const normalized = text.normalize('NFC');
    const chars = [...normalized];
    if (chars.length === 0 || normalized.trim() === '') {
        throw new Error(`${options.field} must not be empty`);
    }
    if (chars.length > options.maxLength) {
        throw new Error(`${options.field} is ${chars.length} characters; the maximum is ${options.maxLength}`);
    }
    for (const [index, char] of chars.entries()) {
        if (char === '\n' && options.allowNewlines) {
            continue;
        }
        if (!ALLOWED_CHAR.test(char)) {
            const codePoint = char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
            throw new Error(
                `${options.field} contains a disallowed character U+${codePoint} at position ${index + 1}; ` +
                'only plain text is accepted (no emoji, control or invisible characters)'
            );
        }
    }
    return normalized;
}
