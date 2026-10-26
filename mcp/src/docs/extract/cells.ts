/** Helpers shared by the spreadsheet readers: CSV lines, numbers, dates. */

export const MAX_SHEET_ROWS = 5_000;
export const MAX_SHEET_COLUMNS = 1_000;

export function csvField(s: string): string {
	return /[",\n\r]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(cells: readonly string[]): string {
	return cells.map(csvField).join(",");
}

/** 15 significant digits, like the spreadsheet apps, without float noise such as 0.30000000000000004. */
export function formatNumber(n: number): string {
	if (Number.isInteger(n)) return String(n);
	return String(Number(n.toPrecision(15)));
}

/**
 * Whether a custom number format shows a date, a time or both. Quoted text, escaped characters and
 * [colour] or [$-locale] sections are ignored; "General" and plain numbers are not dates.
 */
export function isDateFormat(code: string): "date" | "datetime" | "time" | null {
	let s = "";
	let inQuote = false;
	for (let i = 0; i < code.length; i++) {
		const ch = code[i] as string;
		if (inQuote) {
			if (ch === '"') inQuote = false;
			continue;
		}
		if (ch === '"') inQuote = true;
		else if (ch === "\\" || ch === "_" || ch === "*") i++;
		else if (ch === "[") {
			const end = code.indexOf("]", i);
			const inner = end > i ? code.slice(i + 1, end).toLowerCase() : "";
			// Elapsed-time sections [h], [mm], [ss] are times.
			if (/^(h+|m+|s+)$/.test(inner)) s += inner[0];
			i = end > i ? end : i;
		} else s += ch;
	}
	s = (s.split(";")[0] ?? "").toLowerCase();
	const hasDate = /[dy]/.test(s) || (/m/.test(s) && !/[hs]/.test(s));
	const hasTime = /[hs]/.test(s);
	if (hasDate && hasTime) return "datetime";
	if (hasDate) return "date";
	if (hasTime) return "time";
	return null;
}

/** An Excel serial (1900 or 1904 system) as an ISO date, date-time or time. */
export function serialToIso(serial: number, kind: "date" | "datetime" | "time", date1904 = false): string {
	const days = serial + (date1904 ? 1462 : 0);
	const ms = Math.round((days * 86_400_000) / 1000) * 1000;
	const d = new Date(Date.UTC(1899, 11, 30) + ms);
	if (Number.isNaN(d.getTime())) return formatNumber(serial);
	const iso = d.toISOString();
	if (kind === "date" && Number.isInteger(serial)) return iso.slice(0, 10);
	if (kind === "time") return iso.slice(11, 19).replace(/:00$/, "");
	if (kind === "date") return iso.slice(0, 10);
	return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}
