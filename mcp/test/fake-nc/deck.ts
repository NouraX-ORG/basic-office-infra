/**
 * Lane E: an in-memory Deck 1.19.1 for contract tests (DESIGN 17.3). It follows what the installed
 * app does, as read on the server on 2026-10-25:
 * - a missing board or card answers 403 {"status":403,"message":"Permission denied"} (Deck's
 *   ExceptionMiddleware hides which), and so does a write without the edit permission;
 * - the REST card routes ignore the board and stack ids in the URL, except that an update moves the
 *   card to the stack in its URL;
 * - the REST card update replaces every field: a missing done or startdate is cleared;
 * - reorder takes an index and marks a card done when it enters a done list;
 * - "Operation not allowed. This board is archived." is a 500;
 * - assigning someone who isn't on the board is a 400, and so is assigning twice.
 * Response shapes copy what drive.nourax.org returned for qa-t1-27.
 */
import { DRIVE, type FakeNc, ocs, type Recorded } from "./index";

export interface FBoard {
	id: number;
	title: string;
	color: string;
	owner: string;
	archived: boolean;
	deletedAt: number;
	shared: { uid: string; edit: boolean }[];
	labels: { id: number; title: string; color: string }[];
}
export interface FStack {
	id: number;
	boardId: number;
	title: string;
	order: number;
	isDoneColumn: boolean;
	deletedAt: number;
}
export interface FCard {
	id: number;
	stackId: number;
	title: string;
	description: string;
	type: string;
	order: number;
	owner: string;
	archived: boolean;
	done: string | null;
	duedate: string | null;
	startdate: string | null;
	deletedAt: number;
	labels: number[];
	assigned: string[];
	createdAt: number;
	lastModified: number;
}
export interface FComment {
	id: number;
	cardId: number;
	actorId: string;
	message: string;
	creationDateTime: string;
	/** Deck's actorType: "users" unless a test says otherwise (for example "deleted_users" or "guests"). */
	actorType?: string;
	/** What Deck shows as the author's name; the account's display name when absent. */
	actorDisplayName?: string;
}

const API = "/index.php/apps/deck/api/v1.0";
const OCS = "/ocs/v2.php/apps/deck/api/v1.0";

function denied(): Response {
	return Response.json({ status: 403, message: "Permission denied" }, { status: 403 });
}
function bad(message: string, status = 400): Response {
	return Response.json({ status, message }, { status });
}

export class FakeDeck {
	boards = new Map<number, FBoard>();
	stacks = new Map<number, FStack>();
	cards = new Map<number, FCard>();
	comments: FComment[] = [];
	private seq = 100;

	constructor(private readonly fake: FakeNc) {
		this.install();
	}

	private next(): number {
		return ++this.seq;
	}

	addBoard(owner: string, title: string, o: Partial<Pick<FBoard, "color" | "archived" | "deletedAt">> & { shareWith?: { uid: string; edit?: boolean }[] } = {}): FBoard {
		const b: FBoard = {
			id: this.next(),
			title,
			color: o.color ?? "0082ff",
			owner,
			archived: o.archived ?? false,
			deletedAt: o.deletedAt ?? 0,
			shared: (o.shareWith ?? []).map((s) => ({ uid: s.uid, edit: s.edit ?? true })),
			labels: [
				{ id: this.next(), title: "Finished", color: "31CC7C" },
				{ id: this.next(), title: "Action needed", color: "FF7A66" },
			],
		};
		this.boards.set(b.id, b);
		return b;
	}

	addStack(boardId: number, title: string, o: { order?: number; done?: boolean } = {}): FStack {
		const s: FStack = { id: this.next(), boardId, title, order: o.order ?? this.stacksOf(boardId).length, isDoneColumn: o.done ?? false, deletedAt: 0 };
		this.stacks.set(s.id, s);
		return s;
	}

	addCard(stackId: number, title: string, o: Partial<Omit<FCard, "id" | "stackId" | "title">> = {}): FCard {
		const owner = o.owner ?? this.boards.get(this.stacks.get(stackId)?.boardId ?? 0)?.owner ?? "nobody";
		const c: FCard = {
			id: this.next(),
			stackId,
			title,
			description: o.description ?? "",
			type: o.type ?? "plain",
			order: o.order ?? this.openCards(stackId).length,
			owner,
			archived: o.archived ?? false,
			done: o.done ?? null,
			duedate: o.duedate ?? null,
			startdate: o.startdate ?? null,
			deletedAt: o.deletedAt ?? 0,
			labels: o.labels ?? [],
			assigned: o.assigned ?? [],
			createdAt: o.createdAt ?? 1792926613,
			lastModified: o.lastModified ?? 1792926613,
		};
		this.cards.set(c.id, c);
		return c;
	}

	stacksOf(boardId: number): FStack[] {
		return [...this.stacks.values()].filter((s) => s.boardId === boardId && !s.deletedAt);
	}

	openCards(stackId: number): FCard[] {
		return [...this.cards.values()].filter((c) => c.stackId === stackId && !c.archived && !c.deletedAt).sort((a, b) => a.order - b.order || a.id - b.id);
	}

	boardOfCard(c: FCard): FBoard | undefined {
		return this.boards.get(this.stacks.get(c.stackId)?.boardId ?? -1);
	}

	canRead(uid: string | null, b: FBoard | undefined): boolean {
		return !!uid && !!b && (b.owner === uid || b.shared.some((s) => s.uid === uid));
	}

	canEdit(uid: string | null, b: FBoard | undefined): boolean {
		return !!uid && !!b && (b.owner === uid || b.shared.some((s) => s.uid === uid && s.edit));
	}

	private user(uid: string) {
		return { primaryKey: uid, uid, displayname: this.fake.users.get(uid)?.displayName ?? uid, type: 0 };
	}

	boardJson(b: FBoard, uid: string, details = true) {
		const edit = this.canEdit(uid, b);
		return {
			id: b.id,
			title: b.title,
			owner: this.user(b.owner),
			teamId: null,
			color: b.color,
			archived: b.archived,
			labels: details ? b.labels.map((l) => ({ ...l, boardId: b.id, cardId: null, lastModified: 1792926612, ETag: "e" })) : [],
			acl: b.shared.map((s, i) => ({ id: 900 + i, participant: this.user(s.uid), type: 0, boardId: b.id, permissionEdit: s.edit, permissionShare: false, permissionManage: false, owner: false })),
			permissions: { PERMISSION_READ: true, PERMISSION_EDIT: edit, PERMISSION_MANAGE: b.owner === uid, PERMISSION_SHARE: b.owner === uid },
			users: details ? [this.user(b.owner), ...b.shared.map((s) => this.user(s.uid))] : [],
			shared: b.owner === uid ? 0 : 1,
			stacks: details ? this.stacksOf(b.id).map((s) => this.stackJson(s)) : [],
			activeSessions: [],
			deletedAt: b.deletedAt,
			lastModified: 1792926617,
			shareToken: null,
			externalId: null,
			settings: details ? { "notify-due": "assigned", calendar: true } : [],
			ETag: "b",
		};
	}

	stackJson(s: FStack, cards?: FCard[]) {
		return {
			id: s.id,
			title: s.title,
			boardId: s.boardId,
			deletedAt: s.deletedAt,
			lastModified: 1792926613,
			...(cards ? { cards: cards.map((c) => this.cardJson(c)) } : {}),
			order: s.order,
			isDoneColumn: s.isDoneColumn,
			ETag: "s",
		};
	}

	cardJson(c: FCard) {
		const b = this.boardOfCard(c);
		return {
			id: c.id,
			title: c.title,
			description: c.description,
			color: null,
			stackId: c.stackId,
			type: c.type,
			lastModified: c.lastModified,
			lastEditor: c.owner,
			createdAt: c.createdAt,
			labels: c.labels.map((id) => {
				const l = b?.labels.find((x) => x.id === id);
				return { id, title: l?.title ?? "?", color: l?.color ?? "000000", boardId: b?.id ?? 0, cardId: c.id, lastModified: 1, ETag: "l" };
			}),
			assignedUsers: c.assigned.map((uid, i) => ({ id: 700 + i, participant: this.user(uid), cardId: c.id, type: 0 })),
			attachments: [],
			attachmentCount: 0,
			owner: this.user(c.owner),
			order: c.order,
			archived: c.archived,
			done: c.done,
			duedate: c.duedate,
			startdate: c.startdate,
			deletedAt: c.deletedAt,
			commentsUnread: 0,
			commentsCount: this.comments.filter((x) => x.cardId === c.id).length,
			dependentCards: [],
			ETag: "c",
			overdue: 0,
			referenceData: null,
		};
	}

	/** Deck stores dates as DateTime and sends them back as ATOM strings in UTC. */
	static atom(raw: unknown): string | null {
		if (raw === null || raw === undefined || raw === "") return null;
		const ms = Date.parse(String(raw));
		if (!Number.isFinite(ms)) throw new Error("bad date");
		return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");
	}

	private reorder(c: FCard, stackId: number, order: number): FCard[] {
		const target = this.stacks.get(stackId);
		if (stackId !== c.stackId && target) {
			if (target.isDoneColumn) c.done = FakeDeck.atom(new Date().toISOString());
			else if (this.stacks.get(c.stackId)?.isDoneColumn) c.done = null;
		}
		c.stackId = stackId;
		const list = [...this.cards.values()].filter((x) => x.stackId === stackId && !x.archived && !x.deletedAt).sort((a, b) => a.order - b.order || a.id - b.id);
		let i = 0;
		for (const x of list) {
			if (x.id === c.id) x.order = order;
			if (i === order) i++;
			if (x.id !== c.id) x.order = i++;
		}
		return list;
	}

	private install(): void {
		const f = this.fake;
		const host = new URL(DRIVE).host;
		const json = (req: Recorded) => (req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {});
		const needOcsHeader = (req: Recorded) => req.headers.get("ocs-apirequest") === "true";

		f.on("GET", new RegExp(`^${API}/boards$`), (req) => {
			if (!req.auth) return new Response("", { status: 401 });
			const details = req.url.searchParams.get("details") === "true";
			return Response.json([...this.boards.values()].filter((b) => this.canRead(req.auth, b)).map((b) => this.boardJson(b, req.auth as string, details)));
		}, host);

		f.on("GET", new RegExp(`^${API}/boards/(\\d+)$`), (req, _f, m) => {
			if (!req.auth) return new Response("", { status: 401 });
			const b = this.boards.get(Number(m[1]));
			if (!this.canRead(req.auth, b) || !b) return denied();
			return Response.json(this.boardJson(b, req.auth));
		}, host);

		f.on("GET", new RegExp(`^${API}/boards/(\\d+)/stacks(/archived)?$`), (req, _f, m) => {
			if (!req.auth) return new Response("", { status: 401 });
			const b = this.boards.get(Number(m[1]));
			if (!this.canRead(req.auth, b) || !b) return denied();
			const archived = Boolean(m[2]);
			return Response.json(
				this.stacksOf(b.id).map((s) =>
					this.stackJson(
						s,
						[...this.cards.values()].filter((c) => c.stackId === s.id && !c.deletedAt && c.archived === archived).sort((x, y) => x.order - y.order),
					),
				),
			);
		}, host);

		f.on("GET", new RegExp(`^${API}/boards/(\\d+)/stacks/(\\d+)/cards/(\\d+)$`), (req, _f, m) => {
			if (!req.auth) return new Response("", { status: 401 });
			const c = this.cards.get(Number(m[3]));
			if (!c || !this.canRead(req.auth, this.boardOfCard(c))) return denied();
			return Response.json(this.cardJson(c));
		}, host);

		f.on("POST", new RegExp(`^${API}/boards/(\\d+)/stacks/(\\d+)/cards$`), (req, _f, m) => {
			if (!req.auth) return new Response("", { status: 401 });
			const s = this.stacks.get(Number(m[2]));
			const b = s ? this.boards.get(s.boardId) : undefined;
			if (!s || !this.canEdit(req.auth, b)) return denied();
			if (b?.archived) return bad("Operation not allowed. This board is archived.", 500);
			const body = json(req);
			if (typeof body.title !== "string" || !body.title || body.title.length > 255) return bad("title must be provided");
			if ("owner" in body) return bad("owner must not be sent");
			const c = this.addCard(s.id, body.title, {
				description: typeof body.description === "string" ? body.description : "",
				type: typeof body.type === "string" ? body.type : "plain",
				order: typeof body.order === "number" ? body.order : 999,
				owner: req.auth,
				duedate: FakeDeck.atom(body.duedate),
			});
			return Response.json(this.cardJson(c));
		}, host);

		f.on("PUT", new RegExp(`^${API}/boards/(\\d+)/stacks/(\\d+)/cards/(\\d+)$`), (req, _f, m) => {
			if (!req.auth) return new Response("", { status: 401 });
			const c = this.cards.get(Number(m[3]));
			const stack = this.stacks.get(Number(m[2]));
			if (!c || !stack || !this.canEdit(req.auth, this.boardOfCard(c)) || !this.canEdit(req.auth, this.boards.get(stack.boardId))) return denied();
			if (this.boardOfCard(c)?.archived) return bad("Operation not allowed. This board is archived.", 500);
			const body = json(req);
			for (const k of ["title", "type", "owner"]) if (typeof body[k] !== "string" || !body[k]) return bad(`${k} must be provided`);
			c.title = body.title as string;
			c.type = body.type as string;
			c.stackId = stack.id;
			c.order = typeof body.order === "number" ? body.order : 0;
			c.description = typeof body.description === "string" ? body.description : "";
			c.duedate = FakeDeck.atom(body.duedate);
			c.startdate = FakeDeck.atom(body.startdate);
			// The trap: done is cleared unless it is sent.
			c.done = "done" in body ? FakeDeck.atom(body.done) : null;
			if (typeof body.archived === "boolean") c.archived = body.archived;
			c.lastModified++;
			return Response.json(this.cardJson(c));
		}, host);

		f.on("PUT", new RegExp(`^${API}/boards/(\\d+)/stacks/(\\d+)/cards/(\\d+)/(assignUser|unassignUser)$`), (req, _f, m) => {
			if (!req.auth) return new Response("", { status: 401 });
			const c = this.cards.get(Number(m[3]));
			const b = c ? this.boardOfCard(c) : undefined;
			if (!c || !this.canEdit(req.auth, b) || !b) return denied();
			const body = json(req);
			const uid = String(body.userId ?? "");
			if (m[4] === "assignUser") {
				if (c.assigned.includes(uid)) return bad("The user is already assigned to the card");
				if (!(b.owner === uid || b.shared.some((s) => s.uid === uid))) return bad("The user is not part of the board");
				c.assigned.push(uid);
				return Response.json({ id: 1, participant: uid, cardId: c.id, type: 0 });
			}
			if (!c.assigned.includes(uid)) return bad(`No assignment for ${uid}found.`, 404);
			c.assigned = c.assigned.filter((x) => x !== uid);
			return Response.json({ id: 1, participant: uid, cardId: c.id, type: 0 });
		}, host);

		f.on("PUT", new RegExp(`^${OCS}/cards/(\\d+)/reorder$`), (req, _f, m) => {
			if (!req.auth) return new Response("", { status: 401 });
			if (!needOcsHeader(req)) return new Response("CSRF check failed", { status: 412 });
			const c = this.cards.get(Number(m[1]));
			const body = json(req);
			const target = this.stacks.get(Number(body.stackId));
			if (!c || !target || !this.canEdit(req.auth, this.boardOfCard(c)) || !this.canEdit(req.auth, this.boards.get(target.boardId))) {
				return ocs(null, 403, "Permission denied");
			}
			if (c.archived) return ocs(null, 500, "Operation not allowed. This card is archived.");
			return ocs(this.reorder(c, target.id, Number(body.order)).map((x) => ({ id: x.id, stackId: x.stackId, order: x.order })));
		}, host);

		f.on("GET", new RegExp(`^${OCS}/cards/(\\d+)/comments$`), (req, _f, m) => {
			if (!req.auth) return new Response("", { status: 401 });
			if (!needOcsHeader(req)) return new Response("CSRF check failed", { status: 412 });
			const c = this.cards.get(Number(m[1]));
			if (!c || !this.canRead(req.auth, this.boardOfCard(c))) return ocs(null, 403, "Permission denied");
			const limit = Math.min(200, Number(req.url.searchParams.get("limit") ?? "20"));
			const list = this.comments.filter((x) => x.cardId === c.id).sort((a, b) => b.id - a.id).slice(0, limit);
			return ocs(
				list.map((x) => ({
					id: x.id,
					objectId: x.cardId,
					message: x.message,
					actorId: x.actorId,
					actorType: x.actorType ?? "users",
					actorDisplayName: x.actorDisplayName ?? f.users.get(x.actorId)?.displayName ?? x.actorId,
					creationDateTime: x.creationDateTime,
					mentions: [],
				})),
			);
		}, host);

		f.on("POST", new RegExp(`^${OCS}/cards/(\\d+)/comments$`), (req, _f, m) => {
			if (!req.auth) return new Response("", { status: 401 });
			if (!needOcsHeader(req)) return new Response("CSRF check failed", { status: 412 });
			const c = this.cards.get(Number(m[1]));
			if (!c || !this.canRead(req.auth, this.boardOfCard(c))) return ocs(null, 403, "Permission denied");
			const body = json(req);
			const message = String(body.message ?? "");
			if ([...message].length > 1000) return ocs(null, 400, "Message exceeds allowed character limit of 1000");
			const x: FComment = { id: this.next(), cardId: c.id, actorId: req.auth, message, creationDateTime: "2026-10-25T10:00:00+00:00" };
			this.comments.push(x);
			return ocs({ id: x.id, objectId: c.id, message, actorId: x.actorId, actorType: "users", actorDisplayName: "x", creationDateTime: x.creationDateTime, mentions: [] });
		}, host);
	}
}
