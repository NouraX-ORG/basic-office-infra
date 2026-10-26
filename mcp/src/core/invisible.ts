/**
 * Invisible Unicode, removed from text written by other people before an assistant reads it
 * (DESIGN 26.5). Moved here from src/mail/invisible.ts in fix round 4, so every result is cleaned,
 * not only mail: file and folder names, event and task texts, cards, comments, contact notes and
 * NoGantt texts can be written by other workspace members or through a public upload link. These
 * characters pass the C0/C1 control filter of frame():
 * - tag characters U+E0000–U+E007F ("ASCII smuggling": hidden text a model reads and a person
 *   doesn't see);
 * - variation selectors U+FE00–U+FE0F and U+E0100–U+E01EF (bytes hidden after a visible character);
 * - bidi controls U+061C, U+200E, U+200F, U+202A–U+202E and U+2066–U+2069 (text that shows in a
 *   different order from how it reads);
 * - zero-width and other invisible format characters: U+00AD, U+034F, U+180E, U+200B–U+200D,
 *   U+2060–U+2064, U+206A–U+206F, U+FEFF and U+FFF9–U+FFFB.
 *
 * dropInvisible() removes all of them: used on free text (mail, descriptions, notes, comments, file
 * content). The cost: emoji lose their joiners and presentation selectors, and a zero-width
 * non-joiner between letters (Persian, Urdu, some Indic scripts) is dropped. Meaning is kept; the text
 * an assistant reads is what a person sees.
 *
 * dropInvisibleKeepJoiners() keeps three of them: the zero-width non-joiner and joiner (U+200C,
 * U+200D) and the variation selectors U+FE00–U+FE0F. It is used on names and paths, which an
 * assistant hands back to the tools: "می‌خواهم.docx" or "❤️ photos" must still name the same item,
 * and those three are part of how such names are written. None of them is read by a model as text
 * (unlike the tag characters), so the hidden-text channel stays closed.
 */

const INVISIBLE = /[­͏؜᠎​-‏‪-‮⁠-⁤⁦-⁯︀-️﻿￹-￻\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

const INVISIBLE_BUT_JOINERS = /[­͏؜᠎​‎‏‪-‮⁠-⁤⁦-⁯﻿￹-￻\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

/** The text without invisible format characters (see above). Everything else is kept as it is. */
export function dropInvisible(s: string): string {
	return s.replace(INVISIBLE, "");
}

/** The same, keeping U+200C, U+200D and U+FE00–U+FE0F, for names and paths (see above). */
export function dropInvisibleKeepJoiners(s: string): string {
	return s.replace(INVISIBLE_BUT_JOINERS, "");
}

/** Whether the text holds any of them (for tests and checks). */
export function hasInvisible(s: string): boolean {
	INVISIBLE.lastIndex = 0;
	const found = INVISIBLE.test(s);
	INVISIBLE.lastIndex = 0;
	return found;
}

/**
 * Keys whose values an assistant hands back to a tool or that name an item or a person: paths,
 * names and ids (path, original_path, to_folder, name, display_name, trash_item_id, ...).
 */
const NAME_KEY = /(?:path|name|folder|_id|^id)$/i;

/**
 * Every string in a result (structuredContent) without invisible characters: names, paths and ids
 * keep their joiners (dropInvisibleKeepJoiners), every other text loses them all. A string in an
 * array is treated by the array's key. Object keys are left as they are (they are the server's).
 */
export function dropInvisibleDeep<T>(value: T, key = ""): T {
	if (typeof value === "string") return (NAME_KEY.test(key) ? dropInvisibleKeepJoiners(value) : dropInvisible(value)) as T;
	if (Array.isArray(value)) return value.map((v) => dropInvisibleDeep(v, key)) as T;
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = dropInvisibleDeep(v, k);
		return out as T;
	}
	return value;
}
