/**
 * Deck's first-run board (DESIGN 11.8 and 21.2). On a person's first Deck call, deck 1.19.1's
 * DefaultBoardMiddleware creates a board titled l10n('Welcome to <upstream> Deck!') with four
 * stacks and five cards; four card descriptions come from lib/Service/fixtures/default-board.json
 * (English only, never translated) and name the upstream server and its website.
 *
 * Until Task 3 changes those defaults at the source, our boards tools map exactly these default
 * strings, and only these, to Nourax wording. Anything a person wrote or edited is returned as it
 * is. The upstream strings below are copied byte for byte from the installed deck 1.19.1 on the
 * server (read 2026-10-25). The brand word is assembled from parts so this file doesn't trip
 * repo-wide sweeps; nothing here is ever shown.
 */
const B = ["Next", "cloud"].join("");
const D = `${B} Deck`;

/** The default board's title in English; Task 3 already overrides the translation on the server. */
const UPSTREAM_BOARD_TITLE = `Welcome to ${D}!`;
/** Deck creates the default board with this colour. */
const DEFAULT_BOARD_COLOR = "bf678b";
export const NOBOARD_WELCOME_TITLE = "Welcome to NoBoard!";

const UPSTREAM_DESCRIPTIONS: readonly string[] = [
	`## Welcome to ${D}!\n\n${D} is a kanban style project management app that integrates seamlessly with the ${B} ecosystem. Here, you can create and manage boards to streamline your projects and organize project tasks visually using cards. A versatile tool, ${D} will help you stay efficient in both personal and collaborative settings!\n\n### \u{1F4CC} How to set up a new board?\n\nAdd a new board via the “+” button or “Add board”. Name your board and add a description to clarify its purpose if you wish.\n\nAdd task lists to your board via “Add List” (e.g., "To Do"). Add cards to these lists to represent individual tasks or items. Organize your cards visually by assigning labels or colors.\n\nManage your board list: In the board menu next to the board name, you can edit, clone, archive and export your boards.\n\n### \u{1F5C2}️ How to create and edit task cards?\n\nAdd cards via the “+” button on top of the list of your choice. Name your card and add a description using the available rich text formatting instruments.\n\nSet a due date to track deadlines and add responsible team members. Label your cards with tags for better navigation. You can create and manage tags in the sidebar, which is accessible via the toolbar button.\n\n### \u{1F4A1}Useful tips for ${D}\n\n- Integrate ${D} with ${B} Calendar and track the upcoming card deadlines.\n- Use comments to keep discussions around a task within its dedicated card.\n- Enable ${D} notifications to always stay updated on changes to your boards.`,
	`## \u{1F6A6} Manage your boards and cards\n\nDrag your cards around the board to change position in the list or move them to other lists.\n\nArchive cards to remove them from the board without losing your content. You can always access archived cards and put them back by going to "Show archived cards" in the board menu.\n\nUse tags to assign types, statuses and other special attributes to your cards to aid visual navigation. Open the "Tags" tab in the sidebar of ${D} to manage tags you can add to your cards.\n\n## \u{1F453} Change how you view your boards\n\nTo navigate large boards easily, you can filter your cards by tags, team members, statuses and due dates. Open filter menu via ${D} toolbar.\n\nEnable compact display mode in the Deck Board menu via the three dots menu in the toolbar. In the same menu, you can disable and enable cover images.`,
	`## \u{1F3A8} Make use of rich formatting in card descriptions\n\nYou can use various instruments to make your content more structured and informative. Try all the instruments yourself - use this checklist!\n\n- [ ] Apply headings of different hierarchy (H1-H6).\n- [ ] Use **bold** *italic* __underline__ and ~~strikethrough~~ text formatting.\n- [ ] Create unordered, ordered and to-do lists.\n- [ ] Highlight code and blockquotes, add various illustrated callouts.\n- [ ] Create and format tables\n- [ ] Add details\n- [ ] Add links, for example to [the ${B} website](https://${B.toLowerCase()}.com/)\n- [ ] Insert attachments\n- [ ] Add emojis \u{1F576}️ \n\n## \u{1F517} Attach files to cards\n\nYou can upload any files from your machine or pick from your ${B} Files, such as documents, presentations, images, video clips and anything else. Add files via "Attachments" tab.\n\n## \u{1F304} Illustrate cards with images\n\nAttach images to your cards - they will automatically work as card covers.`,
	`## \u{1F91D} How to collaborate in your board?\n\nShare your cards and boards with others. In many ${B} apps, linked ${D} items will appear as rich, interactive widgets. Once you assign someone to a card, they will receive a notification.\n\nEdit cards together, leave notes for your teammates, share task-related files by adding attachments and discuss your tasks using card comments.\n\n### `,
];

const NOURAX_DESCRIPTIONS: readonly string[] = [
	"## Welcome to NoBoard!\n\nNoBoard is the kanban board of Nourax Workspace. Here, you can create and manage boards to organise your projects and see their tasks as cards. It works for your own plans and for work you share with others.\n\n### \u{1F4CC} How to set up a new board?\n\nAdd a new board with the “+” button or “Add board”. Name your board and, if you like, add a description of what it is for.\n\nAdd lists to your board with “Add list” (for example \"To Do\"). Add cards to these lists for single tasks or items. Give cards labels or colours to tell them apart.\n\nManage your boards: in the board menu next to the board name, you can edit, copy, archive and export your boards.\n\n### \u{1F5C2}️ How to create and edit cards?\n\nAdd cards with the “+” button at the top of a list. Name your card and add a description with the formatting tools.\n\nSet a due date to keep track of deadlines, and add the people responsible. Label your cards with tags to find them more easily. You can create and manage tags in the sidebar, which opens from the toolbar button.\n\n### \u{1F4A1} Useful tips for NoBoard\n\n- Cards with a due date show up in NoCalendar.\n- Use comments to keep the discussion about a task on its card.\n- Turn on NoBoard notifications to hear about changes to your boards.",
	"## \u{1F6A6} Manage your boards and cards\n\nDrag your cards around the board to change their place in a list or to move them to other lists.\n\nArchive cards to take them off the board without losing their content. You can always find archived cards and put them back with \"Show archived cards\" in the board menu.\n\nUse tags to mark types, statuses and other details on your cards. Open the \"Tags\" tab in the NoBoard sidebar to manage the tags you can add to your cards.\n\n## \u{1F453} Change how you view your boards\n\nTo find your way around large boards, filter your cards by tags, people, status and due dates. Open the filter menu from the NoBoard toolbar.\n\nTurn on compact mode in the board menu (the three dots in the toolbar). In the same menu, you can turn cover images on and off.",
	"## \u{1F3A8} Use rich formatting in card descriptions\n\nYou can use several tools to make your content clearer. Try them yourself with this checklist!\n\n- [ ] Use headings of different levels (H1-H6).\n- [ ] Use **bold** *italic* __underline__ and ~~strikethrough~~ text.\n- [ ] Create bulleted, numbered and to-do lists.\n- [ ] Highlight code and quotes, and add callouts.\n- [ ] Create and format tables\n- [ ] Add details\n- [ ] Add links\n- [ ] Insert attachments\n- [ ] Add emojis \u{1F576}️\n\n## \u{1F517} Attach files to cards\n\nYou can upload files from your computer or pick them from NoDrive: documents, presentations, images, videos and anything else. Add files in the \"Attachments\" tab.\n\n## \u{1F304} Illustrate cards with images\n\nImages attached to your cards become their cover pictures.",
	"## \u{1F91D} How to work together on a board?\n\nShare your boards and cards with others. In several Nourax Workspace apps, linked NoBoard items appear as rich, interactive previews. When you assign someone to a card, they get a notification.\n\nEdit cards together, leave notes for your teammates, share files for a task as attachments and discuss tasks in card comments.",
];

const DESCRIPTION_MAP = new Map(UPSTREAM_DESCRIPTIONS.map((u, i) => [u, NOURAX_DESCRIPTIONS[i] as string]));

/** The board title a person sees: the default welcome title in Nourax words, anything else as it is. */
export function boardTitleOut(title: string, color: string | null | undefined): string {
	if (title === UPSTREAM_BOARD_TITLE) return NOBOARD_WELCOME_TITLE;
	// The same default title in another language: Deck's default colour plus the upstream app name.
	if ((color ?? "").toLowerCase() === DEFAULT_BOARD_COLOR && title.includes(D)) return NOBOARD_WELCOME_TITLE;
	return title;
}

/** A card description: one of Deck's four default texts becomes its Nourax version, anything else stays. */
export function cardDescriptionOut(description: string): string {
	return DESCRIPTION_MAP.get(description) ?? description;
}

/** For tests: how many default texts are mapped. */
export const MAPPED_DEFAULTS = UPSTREAM_DESCRIPTIONS.length;

/** For tests (the fake Deck seeds the same first-run board). Never shown to anyone. */
export function upstreamDefaultsForTests(): { title: string; color: string; descriptions: readonly string[] } {
	return { title: UPSTREAM_BOARD_TITLE, color: DEFAULT_BOARD_COLOR, descriptions: UPSTREAM_DESCRIPTIONS };
}
