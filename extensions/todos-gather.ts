import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";

const TODO_DIR_NAME = ".pi/todos";
const TODO_PATH_ENV = "PI_TODO_PATH";
const TODO_ID_PREFIX = "TODO-";
const TODO_ID_PATTERN = /^[a-f0-9]{8}$/i;
const LOCK_TTL_MS = 30 * 60 * 1000;

interface TodoFrontMatter {
	id: string;
	title: string;
	tags: string[];
	status: string;
	created_at: string;
	assigned_to_session?: string;
}

interface TodoRecord extends TodoFrontMatter {
	body: string;
}

interface LockInfo {
	id: string;
	pid: number;
	session?: string | null;
	created_at: string;
}

interface GitWorktreeInfo {
	path: string;
	branch?: string;
	head?: string;
}

interface GatherSourceTodo {
	worktree: GitWorktreeInfo;
	todo: TodoRecord;
}

interface GatherStateRef {
	targetId: string;
	todo: TodoRecord;
	source?: GitWorktreeInfo;
	isCurrent: boolean;
}

interface GatherPlanPreview {
	imports: Array<{ targetId: string; incoming: GatherSourceTodo }>;
	duplicates: Array<{ incoming: GatherSourceTodo; matched: GatherStateRef }>;
	conflicts: Array<{ existing: GatherStateRef; incoming: GatherSourceTodo }>;
}

function formatTodoId(id: string): string {
	return `${TODO_ID_PREFIX}${id}`;
}

function normalizeTodoTitle(title: string): string {
	return title.trim().replace(/\s+/g, " ").toLowerCase();
}

function getTodoIdentityKey(todo: Pick<TodoFrontMatter, "title" | "created_at">): string | null {
	const title = normalizeTodoTitle(todo.title || "");
	const createdAt = (todo.created_at || "").trim();
	if (!title || !createdAt) return null;
	return `${title}\n${createdAt}`;
}

function sameTodoIdentity(
	a: Pick<TodoFrontMatter, "title" | "created_at">,
	b: Pick<TodoFrontMatter, "title" | "created_at">,
): boolean {
	const left = getTodoIdentityKey(a);
	const right = getTodoIdentityKey(b);
	return left !== null && left === right;
}

function normalizeTodoId(id: string): string {
	let trimmed = id.trim();
	if (trimmed.startsWith("#")) trimmed = trimmed.slice(1);
	if (trimmed.toUpperCase().startsWith(TODO_ID_PREFIX)) {
		trimmed = trimmed.slice(TODO_ID_PREFIX.length);
	}
	return trimmed;
}

function displayTodoId(id: string): string {
	return formatTodoId(normalizeTodoId(id));
}

function getTodosDir(cwd: string): string {
	const overridePath = process.env[TODO_PATH_ENV];
	if (overridePath && overridePath.trim()) {
		return path.resolve(cwd, overridePath.trim());
	}
	return path.resolve(cwd, TODO_DIR_NAME);
}

function getTodosDirLabel(cwd: string): string {
	const overridePath = process.env[TODO_PATH_ENV];
	if (overridePath && overridePath.trim()) {
		return path.resolve(cwd, overridePath.trim());
	}
	return TODO_DIR_NAME;
}

function getTodoPath(todosDir: string, id: string): string {
	return path.join(todosDir, `${id}.md`);
}

function getLockPath(todosDir: string, id: string): string {
	return path.join(todosDir, `${id}.lock`);
}

function findJsonObjectEnd(content: string): number {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < content.length; i += 1) {
		const char = content[i];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}

		if (char === "{") {
			depth += 1;
			continue;
		}

		if (char === "}") {
			depth -= 1;
			if (depth === 0) return i;
		}
	}

	return -1;
}

function splitFrontMatter(content: string): { frontMatter: string; body: string } {
	if (!content.startsWith("{")) {
		return { frontMatter: "", body: content };
	}

	const endIndex = findJsonObjectEnd(content);
	if (endIndex === -1) {
		return { frontMatter: "", body: content };
	}

	const frontMatter = content.slice(0, endIndex + 1);
	const body = content.slice(endIndex + 1).replace(/^\r?\n+/, "");
	return { frontMatter, body };
}

function parseFrontMatter(text: string, idFallback: string): TodoFrontMatter {
	const data: TodoFrontMatter = {
		id: idFallback,
		title: "",
		tags: [],
		status: "open",
		created_at: "",
		assigned_to_session: undefined,
	};

	const trimmed = text.trim();
	if (!trimmed) return data;

	try {
		const parsed = JSON.parse(trimmed) as Partial<TodoFrontMatter> | null;
		if (!parsed || typeof parsed !== "object") return data;
		if (typeof parsed.id === "string" && parsed.id) data.id = parsed.id;
		if (typeof parsed.title === "string") data.title = parsed.title;
		if (typeof parsed.status === "string" && parsed.status) data.status = parsed.status;
		if (typeof parsed.created_at === "string") data.created_at = parsed.created_at;
		if (typeof parsed.assigned_to_session === "string" && parsed.assigned_to_session.trim()) {
			data.assigned_to_session = parsed.assigned_to_session;
		}
		if (Array.isArray(parsed.tags)) {
			data.tags = parsed.tags.filter((tag): tag is string => typeof tag === "string");
		}
	} catch {
		return data;
	}

	return data;
}

function parseTodoContent(content: string, idFallback: string): TodoRecord {
	const { frontMatter, body } = splitFrontMatter(content);
	const parsed = parseFrontMatter(frontMatter, idFallback);
	return {
		id: idFallback,
		title: parsed.title,
		tags: parsed.tags ?? [],
		status: parsed.status,
		created_at: parsed.created_at,
		assigned_to_session: parsed.assigned_to_session,
		body: body ?? "",
	};
}

function serializeTodo(todo: TodoRecord): string {
	const frontMatter = JSON.stringify(
		{
			id: todo.id,
			title: todo.title,
			tags: todo.tags ?? [],
			status: todo.status,
			created_at: todo.created_at,
			assigned_to_session: todo.assigned_to_session || undefined,
		},
		null,
		2,
	);

	const body = todo.body ?? "";
	const trimmedBody = body.replace(/^\n+/, "").replace(/\s+$/, "");
	if (!trimmedBody) return `${frontMatter}\n`;
	return `${frontMatter}\n\n${trimmedBody}\n`;
}

async function ensureTodosDir(todosDir: string): Promise<void> {
	await fs.mkdir(todosDir, { recursive: true });
}

async function readTodoFile(filePath: string, idFallback: string): Promise<TodoRecord> {
	const content = await fs.readFile(filePath, "utf8");
	return parseTodoContent(content, idFallback);
}

async function writeTodoFile(filePath: string, todo: TodoRecord): Promise<void> {
	await fs.writeFile(filePath, serializeTodo(todo), "utf8");
}

async function listTodoRecords(todosDir: string): Promise<TodoRecord[]> {
	let entries: string[] = [];
	try {
		entries = await fs.readdir(todosDir);
	} catch {
		return [];
	}

	const todos: TodoRecord[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const id = entry.slice(0, -3);
		const filePath = path.join(todosDir, entry);
		try {
			todos.push(await readTodoFile(filePath, id));
		} catch {
			// ignore unreadable todo
		}
	}

	return [...todos].sort((a, b) => {
		return (a.created_at || "").localeCompare(b.created_at || "") || a.id.localeCompare(b.id);
	});
}

async function generateTodoId(todosDir: string): Promise<string> {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const id = crypto.randomBytes(4).toString("hex");
		if (!existsSync(getTodoPath(todosDir, id))) return id;
	}
	throw new Error("Failed to generate unique todo id");
}

function parseWorktreeBranch(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const prefix = "refs/heads/";
	return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}

async function getCurrentWorktreeRoot(pi: ExtensionAPI, cwd: string): Promise<string | null> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
	if (result.code !== 0) return null;
	const root = result.stdout.trim();
	return root ? path.resolve(root) : null;
}

async function listGitWorktrees(pi: ExtensionAPI, cwd: string): Promise<GitWorktreeInfo[] | null> {
	const result = await pi.exec("git", ["worktree", "list", "--porcelain"], { cwd });
	if (result.code !== 0) return null;

	const worktrees: GitWorktreeInfo[] = [];
	const blocks = result.stdout.split(/\n\s*\n/g);
	for (const block of blocks) {
		const lines = block
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		if (!lines.length) continue;

		let worktreePath: string | undefined;
		let branch: string | undefined;
		let head: string | undefined;
		for (const line of lines) {
			if (line.startsWith("worktree ")) {
				worktreePath = line.slice("worktree ".length).trim();
				continue;
			}
			if (line.startsWith("branch ")) {
				branch = parseWorktreeBranch(line.slice("branch ".length));
				continue;
			}
			if (line.startsWith("HEAD ")) {
				head = line.slice("HEAD ".length).trim() || undefined;
			}
		}

		if (!worktreePath) continue;
		worktrees.push({
			path: path.resolve(worktreePath),
			branch,
			head,
		});
	}

	return worktrees;
}

function formatWorktreeLabel(worktree: GitWorktreeInfo): string {
	const branch = worktree.branch?.trim();
	if (branch) return `${branch} (${worktree.path})`;
	return worktree.path;
}

function buildGatherPreview(
	preview: GatherPlanPreview,
	sources: GatherSourceTodo[],
	skippedMissingWorktrees: string[],
): string {
	const lines = [
		`Scanned ${sources.length} todos from ${new Set(sources.map((source) => source.worktree.path)).size} worktrees.`,
		`Will import ${preview.imports.length} todos.`,
		`Will skip ${preview.duplicates.length} existing/duplicate todos.`,
		`Needs resolution for ${preview.conflicts.length} conflicts.`,
	];

	if (skippedMissingWorktrees.length) {
		lines.push(`Skipped ${skippedMissingWorktrees.length} missing worktrees.`);
	}

	const appendSection = (title: string, items: string[]) => {
		if (!items.length) return;
		lines.push("");
		lines.push(title);
		lines.push(...items);
	};

	appendSection(
		"Imports:",
		preview.imports.slice(0, 10).map(({ targetId, incoming }) => {
			const title = incoming.todo.title || "(untitled)";
			return `- ${formatTodoId(targetId)} ${title} ← ${formatWorktreeLabel(incoming.worktree)}`;
		}),
	);
	appendSection(
		"Duplicates:",
		preview.duplicates.slice(0, 10).map(({ incoming, matched }) => {
			const title = incoming.todo.title || "(untitled)";
			return `- ${formatTodoId(incoming.todo.id)} ${title} already matches ${formatTodoId(matched.targetId)}`;
		}),
	);
	appendSection(
		"Conflicts:",
		preview.conflicts.slice(0, 10).map(({ existing, incoming }) => {
			const incomingTitle = incoming.todo.title || "(untitled)";
			const existingTitle = existing.todo.title || "(untitled)";
			return `- ${formatTodoId(incoming.todo.id)} incoming "${incomingTitle}" conflicts with existing "${existingTitle}"`;
		}),
	);

	const hiddenCount =
		Math.max(0, preview.imports.length - 10) +
		Math.max(0, preview.duplicates.length - 10) +
		Math.max(0, preview.conflicts.length - 10);
	if (hiddenCount > 0) {
		lines.push("");
		lines.push(`...and ${hiddenCount} more items.`);
	}

	return lines.join("\n");
}

function appendGatherProvenance(todo: TodoRecord, worktree: GitWorktreeInfo): string {
	const details = [
		"Imported from another worktree:",
		`- Path: ${worktree.path}`,
		`- Branch: ${worktree.branch || "(detached)"}`,
		`- Source todo: ${formatTodoId(todo.id)}`,
	];
	const note = details.join("\n");
	const body = todo.body.trim();
	return body ? `${body}\n\n${note}\n` : `${note}\n`;
}

async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
	try {
		const raw = await fs.readFile(lockPath, "utf8");
		return JSON.parse(raw) as LockInfo;
	} catch {
		return null;
	}
}

async function acquireLock(
	todosDir: string,
	id: string,
	ctx: Pick<ExtensionCommandContext, "hasUI" | "sessionManager" | "ui">,
): Promise<(() => Promise<void>) | { error: string }> {
	const lockPath = getLockPath(todosDir, id);
	const now = Date.now();
	const session = ctx.sessionManager.getSessionFile();

	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const handle = await fs.open(lockPath, "wx");
			const info: LockInfo = {
				id,
				pid: process.pid,
				session,
				created_at: new Date(now).toISOString(),
			};
			await handle.writeFile(JSON.stringify(info, null, 2), "utf8");
			await handle.close();
			return async () => {
				try {
					await fs.unlink(lockPath);
				} catch {
					// ignore
				}
			};
		} catch (error: any) {
			if (error?.code !== "EEXIST") {
				return { error: `Failed to acquire lock: ${error?.message ?? "unknown error"}` };
			}
			const stats = await fs.stat(lockPath).catch(() => null);
			const lockAge = stats ? now - stats.mtimeMs : LOCK_TTL_MS + 1;
			if (lockAge <= LOCK_TTL_MS) {
				const info = await readLockInfo(lockPath);
				const owner = info?.session ? ` (session ${info.session})` : "";
				return { error: `Todo ${displayTodoId(id)} is locked${owner}. Try again later.` };
			}
			if (!ctx.hasUI) {
				return { error: `Todo ${displayTodoId(id)} lock is stale; rerun in interactive mode to steal it.` };
			}
			const ok = await ctx.ui.confirm(
				"Todo locked",
				`Todo ${displayTodoId(id)} appears locked. Steal the lock?`,
			);
			if (!ok) {
				return { error: `Todo ${displayTodoId(id)} remains locked.` };
			}
			await fs.unlink(lockPath).catch(() => undefined);
		}
	}

	return { error: `Failed to acquire lock for todo ${displayTodoId(id)}.` };
}

async function withTodoLock<T>(
	todosDir: string,
	id: string,
	ctx: Pick<ExtensionCommandContext, "hasUI" | "sessionManager" | "ui">,
	fn: () => Promise<T>,
): Promise<T | { error: string }> {
	const lock = await acquireLock(todosDir, id, ctx);
	if (typeof lock === "object" && "error" in lock) return lock;
	try {
		return await fn();
	} finally {
		await lock();
	}
}

function notifyOrPrint(
	ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">,
	message: string,
	level: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	else if (level === "error") console.error(message);
	else console.log(message);
}

export default function todosGatherExtension(pi: ExtensionAPI) {
	pi.registerCommand("todos-gather", {
		description: "Gather todos from other git worktrees into this worktree",
		handler: async (_args, ctx) => {
			const currentRoot = await getCurrentWorktreeRoot(pi, ctx.cwd);
			if (!currentRoot) {
				notifyOrPrint(ctx, "Not in a git repository", "error");
				return;
			}

			const worktrees = await listGitWorktrees(pi, ctx.cwd);
			if (!worktrees) {
				notifyOrPrint(ctx, "Failed to list git worktrees", "error");
				return;
			}

			const currentRootRealPath = await fs.realpath(currentRoot).catch(() => currentRoot);
			const currentTodosDir = getTodosDir(currentRoot);
			await ensureTodosDir(currentTodosDir);
			const currentTodos = await listTodoRecords(currentTodosDir);
			const skippedMissingWorktrees: string[] = [];
			const sources: GatherSourceTodo[] = [];

			for (const worktree of worktrees) {
				const resolvedWorktreePath = await fs.realpath(worktree.path).catch(() => null);
				if (!resolvedWorktreePath) {
					skippedMissingWorktrees.push(worktree.path);
					continue;
				}
				if (resolvedWorktreePath === currentRootRealPath) continue;

				const sourceWorktree = { ...worktree, path: resolvedWorktreePath };
				const sourceTodos = await listTodoRecords(getTodosDir(sourceWorktree.path));
				for (const todo of sourceTodos) {
					sources.push({ worktree: sourceWorktree, todo });
				}
			}

			sources.sort((a, b) => {
				return (
					formatWorktreeLabel(a.worktree).localeCompare(formatWorktreeLabel(b.worktree)) ||
					(a.todo.created_at || "").localeCompare(b.todo.created_at || "") ||
					(a.todo.title || "").localeCompare(b.todo.title || "") ||
					a.todo.id.localeCompare(b.todo.id)
				);
			});

			const addStateRef = (
				stateById: Map<string, GatherStateRef>,
				stateByIdentity: Map<string, GatherStateRef>,
				ref: GatherStateRef,
			) => {
				stateById.set(ref.targetId, ref);
				const identityKey = getTodoIdentityKey(ref.todo);
				if (identityKey) stateByIdentity.set(identityKey, ref);
			};

			const removeStateRef = (
				stateById: Map<string, GatherStateRef>,
				stateByIdentity: Map<string, GatherStateRef>,
				ref: GatherStateRef,
			) => {
				if (stateById.get(ref.targetId) === ref) {
					stateById.delete(ref.targetId);
				}
				const identityKey = getTodoIdentityKey(ref.todo);
				if (identityKey && stateByIdentity.get(identityKey) === ref) {
					stateByIdentity.delete(identityKey);
				}
			};

			const seedState = () => {
				const stateById = new Map<string, GatherStateRef>();
				const stateByIdentity = new Map<string, GatherStateRef>();

				for (const todo of currentTodos) {
					addStateRef(stateById, stateByIdentity, {
						targetId: todo.id,
						todo,
						isCurrent: true,
					});
				}
				return { stateById, stateByIdentity };
			};

			const buildPreview = (): GatherPlanPreview => {
				const { stateById, stateByIdentity } = seedState();
				const preview: GatherPlanPreview = { imports: [], duplicates: [], conflicts: [] };

				for (const incoming of sources) {
					const existingById = stateById.get(incoming.todo.id);
					if (existingById) {
						if (sameTodoIdentity(existingById.todo, incoming.todo)) {
							preview.duplicates.push({ incoming, matched: existingById });
							continue;
						}
						preview.conflicts.push({ existing: existingById, incoming });
						continue;
					}

					const identityKey = getTodoIdentityKey(incoming.todo);
					if (identityKey) {
						const existingByIdentity = stateByIdentity.get(identityKey);
						if (existingByIdentity) {
							preview.duplicates.push({ incoming, matched: existingByIdentity });
							continue;
						}
					}

					const acceptedRef: GatherStateRef = {
						targetId: incoming.todo.id,
						todo: incoming.todo,
						source: incoming.worktree,
						isCurrent: false,
					};
					addStateRef(stateById, stateByIdentity, acceptedRef);
					preview.imports.push({ targetId: incoming.todo.id, incoming });
				}

				return preview;
			};

			if (!sources.length) {
				notifyOrPrint(ctx, "No todos found in other worktrees", "info");
				return;
			}

			const preview = buildPreview();
			const previewText = buildGatherPreview(preview, sources, skippedMissingWorktrees);

			if (!ctx.hasUI) {
				console.log(previewText);
				if (preview.imports.length || preview.conflicts.length) {
					console.log("\nRerun in interactive mode to apply changes.");
				}
				return;
			}

			const confirmGather = await ctx.ui.confirm("Gather todos", previewText);
			if (!confirmGather) {
				ctx.ui.notify("Todo gather cancelled", "info");
				return;
			}

			const createImportedTodo = (incoming: GatherSourceTodo, targetId: string): TodoRecord => ({
				...incoming.todo,
				id: targetId,
				assigned_to_session: undefined,
				body: appendGatherProvenance(incoming.todo, incoming.worktree),
			});

			const plannedWrites = new Map<string, TodoRecord>();
			const { stateById, stateByIdentity } = seedState();

			for (const incoming of sources) {
				const existingById = stateById.get(incoming.todo.id);
				if (existingById) {
					if (sameTodoIdentity(existingById.todo, incoming.todo)) {
						continue;
					}

					const choice = await ctx.ui.select(`Resolve conflict for ${formatTodoId(incoming.todo.id)}`, [
						`keep existing — ${existingById.todo.title || "(untitled)"}`,
						`take incoming — ${incoming.todo.title || "(untitled)"} from ${formatWorktreeLabel(incoming.worktree)}`,
						"keep both — import incoming with a new id",
						"cancel",
					]);
					if (!choice || choice === "cancel") {
						ctx.ui.notify("Todo gather cancelled", "info");
						return;
					}
					if (choice.startsWith("keep existing")) {
						continue;
					}
					if (choice.startsWith("take incoming")) {
						const importedTodo = createImportedTodo(incoming, incoming.todo.id);
						removeStateRef(stateById, stateByIdentity, existingById);
						const ref: GatherStateRef = {
							targetId: importedTodo.id,
							todo: importedTodo,
							source: incoming.worktree,
							isCurrent: false,
						};
						addStateRef(stateById, stateByIdentity, ref);
						plannedWrites.set(importedTodo.id, importedTodo);
						continue;
					}

					let newId = incoming.todo.id;
					do {
						newId = await generateTodoId(currentTodosDir);
					} while (stateById.has(newId) || plannedWrites.has(newId));
					const importedTodo = createImportedTodo(incoming, newId);
					const ref: GatherStateRef = {
						targetId: importedTodo.id,
						todo: importedTodo,
						source: incoming.worktree,
						isCurrent: false,
					};
					addStateRef(stateById, stateByIdentity, ref);
					plannedWrites.set(importedTodo.id, importedTodo);
					continue;
				}

				const identityKey = getTodoIdentityKey(incoming.todo);
				if (identityKey && stateByIdentity.has(identityKey)) {
					continue;
				}

				const importedTodo = createImportedTodo(incoming, incoming.todo.id);
				const ref: GatherStateRef = {
					targetId: importedTodo.id,
					todo: importedTodo,
					source: incoming.worktree,
					isCurrent: false,
				};
				addStateRef(stateById, stateByIdentity, ref);
				plannedWrites.set(importedTodo.id, importedTodo);
			}

			if (plannedWrites.size === 0) {
				ctx.ui.notify("No todos needed importing", "info");
				return;
			}

			let appliedCount = 0;
			const failures: string[] = [];
			for (const [todoId, todo] of plannedWrites) {
				const filePath = getTodoPath(currentTodosDir, todoId);
				const result = await withTodoLock(currentTodosDir, todoId, ctx, async () => {
					await writeTodoFile(filePath, todo);
					return true;
				});
				if (typeof result === "object" && "error" in result) {
					failures.push(result.error);
					continue;
				}
				appliedCount += 1;
			}

			if (appliedCount > 0) {
				ctx.ui.notify(`Gathered ${appliedCount} todos into ${getTodosDirLabel(currentRoot)}`, "info");
			}
			if (failures.length) {
				ctx.ui.notify(failures[0], "error");
			}
		},
	});
}
