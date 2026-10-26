/**
 * Zip reading and writing for Office and OpenDocument files (DESIGN 12.4, zip guards).
 *
 * Reading uses our own central-directory parser plus fflate's streaming Inflate with output
 * counters, because the sizes a zip declares can't be trusted (a zip bomb lies about them):
 * - at most 2,000 entries, 30 MB out per part and 60 MB out in total (past these, a normal-looking
 *   file is TooBigHere, so files_read_text can use the connector's conversion instead);
 * - a part that inflates more than 100 times its packed size, once it is also past 4 MB, is refused
 *   as a bomb (fix round 3: the floor was 1 MB, which refused our own highly repetitive writer
 *   output — a table of identical rows or many short paragraphs packs 100x+ but is a megabyte or two
 *   unpacked; 4 MB is the whole-part read size below, and the 30 MB per-part / 60 MB total caps with
 *   the 4 KB streaming are what bound memory, so the ratio only needs to catch a true bomb before it
 *   reaches those caps);
 * - packed input goes to Inflate 4 KB at a time, so one output callback holds about 4 MB at most
 *   (deflate expands at most about 1,032 times) and the counters run before memory piles up;
 * - a part read whole is at most 4 MB; bigger parts are streamed;
 * - encrypted entries and unknown compression methods are refused;
 * - a part is only inflated when it is asked for.
 * Writing uses fflate's zipSync for the writers, and ZipBuilder (raw copies of unchanged parts plus
 * streaming deflate) for filled templates, so a template's parts are never all held unpacked.
 */
import { Deflate, Inflate, deflateSync, zipSync } from "fflate";
import { ToolError } from "../core/errors";
import { LIMITS } from "../core/limits";
import { TooBigHere } from "./errors";
import { DOC_LIMITS } from "./limits";

export interface ZipEntry {
	name: string;
	method: number;
	flags: number;
	/** CRC-32 from the central directory (copied as it is when a part is copied unchanged). */
	crc: number;
	/** Packed size from the central directory (bounds-checked against the file). */
	csize: number;
	/** Declared unpacked size: informational only, never trusted. */
	usize: number;
	offset: number;
}

export interface ZipLimits {
	partBytes: number;
	totalBytes: number;
	entries: number;
	/** Largest allowed unpacked/packed ratio, checked once a part is past `ratioFloor` bytes. */
	ratio: number;
	ratioFloor: number;
}

export const ZIP_LIMITS: ZipLimits = {
	partBytes: LIMITS.unzipPartBytes,
	totalBytes: LIMITS.unzipTotalBytes,
	entries: LIMITS.unzipEntries,
	ratio: 100,
	// 4 MB (fix round 3): below this a part is read whatever its ratio, so legitimate highly
	// compressible output (a docx of a repeated table or many short paragraphs, a sheet of identical
	// rows) is read back; the whole-part read size is also 4 MB, and the per-part and total caps still
	// bound memory. Only a part that is both large and wildly disproportionate is refused early.
	ratioFloor: 4 * 1024 * 1024,
};

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
/** Stored (method 0) entries are handed over in 64 KB pieces: they can't expand. */
const STORED_CHUNK = 64 * 1024;

function u16(b: Uint8Array, i: number): number {
	return (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
}
function u32(b: Uint8Array, i: number): number {
	return ((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16) | ((b[i + 3] ?? 0) << 24)) >>> 0;
}
function u64(b: Uint8Array, i: number): number {
	const lo = u32(b, i);
	const hi = u32(b, i + 4);
	// Anything that needs more than 53 bits is far past our limits anyway.
	return hi * 0x100000000 + lo;
}

function broken(): ToolError {
	return new ToolError("unsupported_type", "This file's contents couldn't be read; it may be damaged or not really an Office file.");
}

function bomb(): ToolError {
	return new ToolError("too_large", "This file unpacks to far more than its size (more than 100 times), so it isn't read here.");
}

function tooBigHere(): TooBigHere {
	return new TooBigHere("This file unpacks to more than this connector reads (60 MB in all, 30 MB per part).");
}

/** Our own early stops pass through the inflater and the XML reader unchanged. */
function passThrough(err: unknown): boolean {
	return err instanceof ToolError || (err instanceof Error && err.name === "StopRead");
}

const nameDecoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });

/** True when the bytes start like a zip file. */
export function looksLikeZip(b: Uint8Array): boolean {
	return b.length >= 4 && u32(b, 0) === SIG_LOC;
}

/** Finds the end-of-central-directory record in the last bytes of a file; -1 when there is none. */
function findEocd(b: Uint8Array): number {
	const stop = Math.max(0, b.length - 22 - 65535);
	for (let i = b.length - 22; i >= stop; i--) {
		if (u32(b, i) === SIG_EOCD && i + 22 + u16(b, i + 20) <= b.length) return i;
	}
	return -1;
}

/**
 * A light soundness check of a zip from its last bytes only (`tail` = the last tail.length bytes of
 * a file of `fileSize` bytes): an end record, a central directory inside the file and, when the
 * directory starts inside the tail, a directory entry where it says. Used before sending a file to
 * the converter, which would otherwise read a damaged zip as plain text.
 */
export function zipTailLooksSound(tail: Uint8Array, fileSize: number): boolean {
	const eocd = findEocd(tail);
	if (eocd < 0) return false;
	const base = fileSize - tail.length;
	let count = u16(tail, eocd + 10);
	let cdSize = u32(tail, eocd + 12);
	let cdOffset = u32(tail, eocd + 16);
	if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
		const loc = eocd - 20;
		if (loc < 0 || u32(tail, loc) !== SIG_EOCD64_LOC) return false;
		const z64 = u64(tail, loc + 8) - base;
		if (z64 < 0 || z64 + 56 > tail.length || u32(tail, z64) !== SIG_EOCD64) return false;
		count = u64(tail, z64 + 32);
		cdSize = u64(tail, z64 + 40);
		cdOffset = u64(tail, z64 + 48);
	}
	if (count === 0 || cdOffset + cdSize > fileSize) return false;
	const local = cdOffset - base;
	if (local >= 0 && local + 4 <= tail.length && u32(tail, local) !== SIG_CEN) return false;
	return true;
}

export class ZipReader {
	readonly entries: ZipEntry[] = [];
	private readonly byLower = new Map<string, ZipEntry>();
	private outTotal = 0;

	private constructor(
		private readonly bytes: Uint8Array,
		private readonly limits: ZipLimits,
	) {}

	/** Parses the central directory. Throws unsupported_type for anything that isn't a sound zip. */
	static open(bytes: Uint8Array, limits: ZipLimits = ZIP_LIMITS): ZipReader {
		const z = new ZipReader(bytes, limits);
		z.readDirectory();
		return z;
	}

	private readDirectory(): void {
		const b = this.bytes;
		if (b.length < 22) throw broken();
		const eocd = findEocd(b);
		if (eocd < 0) throw broken();
		let count = u16(b, eocd + 10);
		let cdSize = u32(b, eocd + 12);
		let cdOffset = u32(b, eocd + 16);
		if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
			const loc = eocd - 20;
			if (loc < 0 || u32(b, loc) !== SIG_EOCD64_LOC) throw broken();
			const z64 = u64(b, loc + 8);
			if (z64 + 56 > b.length || u32(b, z64) !== SIG_EOCD64) throw broken();
			count = u64(b, z64 + 32);
			cdSize = u64(b, z64 + 40);
			cdOffset = u64(b, z64 + 48);
		}
		if (count > this.limits.entries) {
			throw new ToolError("too_large", `This file holds more than ${this.limits.entries.toLocaleString("en-GB")} parts, more than this connector reads.`);
		}
		if (cdOffset + cdSize > b.length) throw broken();
		let p = cdOffset;
		for (let n = 0; n < count; n++) {
			if (p + 46 > b.length || u32(b, p) !== SIG_CEN) throw broken();
			const flags = u16(b, p + 8);
			const method = u16(b, p + 10);
			const crc = u32(b, p + 16);
			let csize = u32(b, p + 20);
			let usize = u32(b, p + 24);
			const fnl = u16(b, p + 28);
			const el = u16(b, p + 30);
			const cl = u16(b, p + 32);
			let offset = u32(b, p + 42);
			if (p + 46 + fnl + el + cl > b.length) throw broken();
			const name = nameDecoder.decode(b.subarray(p + 46, p + 46 + fnl));
			// Zip64 extra field: the 64-bit values appear only for the fields that are 0xFFFFFFFF.
			let e = p + 46 + fnl;
			const eEnd = e + el;
			while (e + 4 <= eEnd) {
				const id = u16(b, e);
				const len = u16(b, e + 2);
				if (id === 0x0001) {
					let q = e + 4;
					if (usize === 0xffffffff && q + 8 <= e + 4 + len) (usize = u64(b, q)), (q += 8);
					if (csize === 0xffffffff && q + 8 <= e + 4 + len) (csize = u64(b, q)), (q += 8);
					if (offset === 0xffffffff && q + 8 <= e + 4 + len) offset = u64(b, q);
				}
				e += 4 + len;
			}
			p += 46 + fnl + el + cl;
			if (name.endsWith("/")) continue; // a folder entry
			const entry: ZipEntry = { name, method, flags, crc, csize, usize, offset };
			const lower = name.toLowerCase();
			if (this.byLower.has(lower)) throw broken(); // two parts with one name: ambiguous, refuse
			this.byLower.set(lower, entry);
			this.entries.push(entry);
		}
	}

	names(): string[] {
		return this.entries.map((e) => e.name);
	}

	/** Part names are case-insensitive in Office files (OPC), so lookups are too. */
	entry(name: string): ZipEntry | undefined {
		return this.byLower.get(name.replace(/^\/+/, "").toLowerCase());
	}

	has(name: string): boolean {
		return this.entry(name) !== undefined;
	}

	/** Bytes unpacked so far by this reader (all parts). */
	get unpackedBytes(): number {
		return this.outTotal;
	}

	/** The packed bytes of an entry (a view into the file), after the entry's local header. */
	packed(e: ZipEntry): Uint8Array {
		const b = this.bytes;
		if (e.flags & 1) throw new ToolError("unsupported_type", "This file is protected with a password, so its text can't be read.");
		if (e.offset + 30 > b.length || u32(b, e.offset) !== SIG_LOC) throw broken();
		const start = e.offset + 30 + u16(b, e.offset + 26) + u16(b, e.offset + 28);
		const end = start + e.csize;
		if (end > b.length) throw broken();
		return b.subarray(start, end);
	}

	/**
	 * Unpacks one part piece by piece into `sink`, counting every byte. Returns false when the part
	 * doesn't exist. Throws too_large for a bomb, TooBigHere past the size limits, unsupported_type
	 * for damaged data, and lets the readers' own stops (StopRead, ToolError) through unchanged.
	 */
	stream(name: string, sink: (chunk: Uint8Array) => void, maxBytes = this.limits.partBytes): boolean {
		const e = this.entry(name);
		if (!e) return false;
		const data = this.packed(e);
		let partOut = 0;
		const count = (n: number) => {
			partOut += n;
			this.outTotal += n;
			if (partOut > this.limits.ratioFloor && partOut > Math.max(1, data.length) * this.limits.ratio) throw bomb();
			if (partOut > maxBytes || partOut > this.limits.partBytes || this.outTotal > this.limits.totalBytes) {
				throw maxBytes < this.limits.partBytes && partOut > maxBytes ? new TooBigHere("A part of this file is too big to read here.") : tooBigHere();
			}
		};
		if (e.method === 0) {
			for (let i = 0; i < data.length; i += STORED_CHUNK) {
				const c = data.subarray(i, Math.min(data.length, i + STORED_CHUNK));
				count(c.length);
				sink(c);
			}
			return true;
		}
		if (e.method !== 8) throw new ToolError("unsupported_type", "This file uses a kind of compression this connector can't read.");
		let ended = false;
		const inf = new Inflate((chunk, final) => {
			if (chunk.length) {
				count(chunk.length);
				sink(chunk);
			}
			if (final) ended = true;
		});
		const step = DOC_LIMITS.inflatePushBytes;
		try {
			if (data.length === 0) inf.push(new Uint8Array(0), true);
			for (let i = 0; i < data.length && !ended; i += step) {
				const last = i + step >= data.length;
				inf.push(data.subarray(i, Math.min(data.length, i + step)), last);
			}
		} catch (err) {
			if (passThrough(err)) throw err;
			throw broken();
		}
		if (!ended && data.length > 0) throw broken();
		return true;
	}

	/** The whole part (at most `maxBytes`, else TooBigHere), or null when it doesn't exist. */
	read(name: string, maxBytes: number = DOC_LIMITS.wholePartBytes): Uint8Array | null {
		const chunks: Uint8Array[] = [];
		let n = 0;
		const ok = this.stream(
			name,
			(c) => {
				chunks.push(c.slice());
				n += c.length;
			},
			maxBytes,
		);
		if (!ok) return null;
		if (chunks.length === 1) return chunks[0] as Uint8Array;
		const out = new Uint8Array(n);
		let o = 0;
		for (const c of chunks) {
			out.set(c, o);
			o += c.length;
		}
		return out;
	}

	/** The whole part as text (UTF-8, or UTF-16 with a byte-order mark; at most `maxBytes`), or null. */
	text(name: string, maxBytes: number = DOC_LIMITS.wholePartBytes): string | null {
		const b = this.read(name, maxBytes);
		return b === null ? null : decodeXmlBytes(b);
	}

	/** Streams a part as decoded text chunks. */
	streamText(name: string, sink: (text: string) => void, maxBytes = this.limits.partBytes): boolean {
		let dec: TextDecoder | null = null;
		const ok = this.stream(
			name,
			(c) => {
				if (!dec) dec = new TextDecoder(c[0] === 0xff && c[1] === 0xfe ? "utf-16le" : c[0] === 0xfe && c[1] === 0xff ? "utf-16be" : "utf-8");
				const s = dec.decode(c, { stream: true });
				if (s) sink(s);
			},
			maxBytes,
		);
		if (ok && dec) {
			const tail = (dec as TextDecoder).decode();
			if (tail) sink(tail);
		}
		return ok;
	}
}

export function decodeXmlBytes(b: Uint8Array): string {
	if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b);
	if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b);
	return new TextDecoder("utf-8").decode(b);
}

const enc = new TextEncoder();

function tooBigOutput(): ToolError {
	return new ToolError("too_large", "The finished file would be larger than 20 MB. Make it smaller or split it into several files.");
}

/**
 * Builds a zip from parts in the order given. Text parts are UTF-8. `stored` names are kept
 * uncompressed (the OpenDocument "mimetype" part must be).
 */
export function writeZip(parts: ReadonlyArray<readonly [string, string | Uint8Array]>, opts: { stored?: ReadonlySet<string>; level?: 0 | 1 | 6 | 9 } = {}): Uint8Array {
	const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
	for (const [name, data] of parts) {
		const bytes = typeof data === "string" ? enc.encode(data) : data;
		files[name] = opts.stored?.has(name) ? [bytes, { level: 0 }] : bytes;
	}
	const out = zipSync(files, { level: opts.level ?? 6, mtime: new Date() });
	if (out.length > LIMITS.docOutputBytes) throw tooBigOutput();
	return out;
}

// ------------------------------------------------------------------ CRC-32 and ZipBuilder

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

/** Updates a CRC-32 (start with 0) with more bytes. */
export function crc32(crc: number, b: Uint8Array): number {
	let c = ~crc >>> 0;
	for (let i = 0; i < b.length; i++) c = (CRC_TABLE[(c ^ (b[i] as number)) & 0xff] as number) ^ (c >>> 8);
	return ~c >>> 0;
}

function dosTime(d: Date): { time: number; date: number } {
	const year = Math.max(1980, d.getUTCFullYear());
	return {
		time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
		date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
	};
}

interface Written {
	name: Uint8Array;
	flags: number;
	method: number;
	crc: number;
	csize: number;
	usize: number;
	offset: number;
}

/** Streams text into one deflated part; `end()` adds it to the builder. */
export interface PartWriter {
	write(s: string): void;
	end(): void;
}

/**
 * A zip written part by part: unchanged parts are copied packed (no unpacking at all), changed
 * parts are deflated as they are produced. Only the packed output is held, and it is refused past
 * 20 MB as it grows.
 */
export class ZipBuilder {
	private readonly out: Uint8Array[] = [];
	private size = 0;
	private readonly written: Written[] = [];
	private readonly stamp = dosTime(new Date());

	constructor(private readonly maxBytes: number = LIMITS.docOutputBytes) {}

	private grow(n: number): void {
		this.size += n;
		if (this.size > this.maxBytes) throw tooBigOutput();
	}

	/**
	 * Adds a part's local header and its packed data. Callers have already counted the packed bytes
	 * (grow, so the 20 MB cap holds while deflating), so the header starts csize bytes before `size`.
	 */
	private add(nameText: string, method: number, crc: number, usize: number, packed: Uint8Array[], csize: number): void {
		const name = enc.encode(nameText);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: an ASCII check
		const flags = /^[\u0000-\u007f]*$/.test(nameText) ? 0 : 0x0800; // UTF-8 names
		const h = new Uint8Array(30 + name.length);
		const v = new DataView(h.buffer);
		v.setUint32(0, SIG_LOC, true);
		v.setUint16(4, 20, true);
		v.setUint16(6, flags, true);
		v.setUint16(8, method, true);
		v.setUint16(10, this.stamp.time, true);
		v.setUint16(12, this.stamp.date, true);
		v.setUint32(14, crc >>> 0, true);
		v.setUint32(18, csize, true);
		v.setUint32(22, usize >>> 0, true);
		v.setUint16(26, name.length, true);
		v.setUint16(28, 0, true);
		h.set(name, 30);
		const offset = this.size - csize;
		this.grow(h.length);
		this.out.push(h);
		for (const p of packed) this.out.push(p);
		this.written.push({ name, flags, method, crc, csize, usize, offset });
	}

	/** Copies a part of `zip` as it is, still packed. */
	copy(zip: ZipReader, e: ZipEntry): void {
		const data = zip.packed(e);
		if (e.method !== 0 && e.method !== 8) throw new ToolError("unsupported_type", "This file uses a kind of compression this connector can't read.");
		if (e.usize > 0xffffffff || data.length > 0xffffffff) throw tooBigOutput();
		this.grow(data.length);
		this.add(e.name, e.method, e.crc, e.usize, [data], data.length);
	}

	/** Adds a whole part, deflated. */
	addBytes(name: string, data: Uint8Array): void {
		const packed = deflateSync(data, { level: 6 });
		this.grow(packed.length);
		this.add(name, 8, crc32(0, data), data.length, [packed], packed.length);
	}

	/** A part written as text in pieces and deflated as it goes. */
	part(name: string): PartWriter {
		let crc = 0;
		let usize = 0;
		let csize = 0;
		const packed: Uint8Array[] = [];
		const def = new Deflate({ level: 6 }, (chunk) => {
			if (!chunk.length) return;
			packed.push(chunk);
			csize += chunk.length;
			this.grow(chunk.length);
		});
		let buf = "";
		const flush = (final: boolean) => {
			const b = enc.encode(buf);
			buf = "";
			crc = crc32(crc, b);
			usize += b.length;
			def.push(b, final);
		};
		return {
			write: (s: string) => {
				buf += s;
				if (buf.length >= 64 * 1024) flush(false);
			},
			end: () => {
				flush(true);
				this.add(name, 8, crc, usize, packed, csize);
			},
		};
	}

	/** The finished zip. */
	finish(): Uint8Array {
		const cdStart = this.size;
		for (const w of this.written) {
			const c = new Uint8Array(46 + w.name.length);
			const v = new DataView(c.buffer);
			v.setUint32(0, SIG_CEN, true);
			v.setUint16(4, 20, true);
			v.setUint16(6, 20, true);
			v.setUint16(8, w.flags, true);
			v.setUint16(10, w.method, true);
			v.setUint16(12, this.stamp.time, true);
			v.setUint16(14, this.stamp.date, true);
			v.setUint32(16, w.crc >>> 0, true);
			v.setUint32(20, w.csize, true);
			v.setUint32(24, w.usize >>> 0, true);
			v.setUint16(28, w.name.length, true);
			v.setUint32(42, w.offset, true);
			c.set(w.name, 46);
			this.grow(c.length);
			this.out.push(c);
		}
		const end = new Uint8Array(22);
		const v = new DataView(end.buffer);
		v.setUint32(0, SIG_EOCD, true);
		v.setUint16(8, this.written.length, true);
		v.setUint16(10, this.written.length, true);
		v.setUint32(12, this.size - cdStart, true);
		v.setUint32(16, cdStart, true);
		this.grow(end.length);
		this.out.push(end);
		const all = new Uint8Array(this.size);
		let o = 0;
		for (const p of this.out) {
			all.set(p, o);
			o += p.length;
		}
		return all;
	}
}
