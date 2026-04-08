import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashTool, isToolCallEventType } from "@mariozechner/pi-coding-agent";

const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MIN_REDACTION_LENGTH = 4;

function isValidSecretName(name: string): boolean {
	return SECRET_NAME_RE.test(name);
}

function redactText(text: string, secrets: Map<string, string>): string {
	let redacted = text;

	const entries = [...secrets.entries()]
		.filter(([, value]) => value.length >= MIN_REDACTION_LENGTH)
		.sort((a, b) => b[1].length - a[1].length);

	for (const [name, value] of entries) {
		if (!value) continue;
		redacted = redacted.split(value).join(`[REDACTED:${name}]`);
	}

	return redacted;
}

function getHelpText(): string {
	return [
		"Runtime secrets commands:",
		"  /secret set <NAME>                Prompt for value and store in memory",
		"  /secret import <NAME> <COMMAND>   Run command and store stdout as secret",
		"  /secret unset <NAME>              Remove one secret",
		"  /secret list                      List secret names (never values)",
		"  /secret clear                     Remove all secrets",
		"",
		"Notes:",
		"- Secrets are in-memory only (not persisted).",
		"- They are injected into bash env vars for tool calls.",
		"- Use $NAME in commands (never paste literal values into chat).",
	].join("\n");
}

export default function runtimeSecrets(pi: ExtensionAPI) {
	const secrets = new Map<string, string>();

	const bashTool = createBashTool(process.cwd(), {
		spawnHook: ({ command, cwd, env }) => {
			const injected = Object.fromEntries(secrets.entries());
			return {
				command,
				cwd,
				env: { ...env, ...injected },
			};
		},
	});

	pi.registerTool({
		...bashTool,
		execute: async (toolCallId, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(toolCallId, params, signal, onUpdate);
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event) || secrets.size === 0) return undefined;

		const command = event.input.command;
		const leakRisk =
			/(^|\s|[;|&])(env|printenv)(\s|$)/.test(command) ||
			/(^|\s|[;|&])set(\s|$)/.test(command) ||
			/echo\s+\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(command);

		if (!leakRisk) return undefined;

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: "Potential secret leak blocked (no UI confirmation available)",
			};
		}

		const allowed = await ctx.ui.confirm(
			"Potential secret leak",
			"This command may print environment variables or secret values. Continue?",
		);

		if (!allowed) {
			return {
				block: true,
				reason: "Blocked by runtime-secrets extension",
			};
		}

		return undefined;
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName !== "bash" || secrets.size === 0) return undefined;

		let changed = false;
		const content = event.content.map((part) => {
			if (part.type !== "text") return part;
			const redactedText = redactText(part.text, secrets);
			if (redactedText !== part.text) changed = true;
			return { ...part, text: redactedText };
		});

		if (!changed) return undefined;
		return { content };
	});

	pi.on("session_shutdown", async () => {
		secrets.clear();
	});

	pi.registerCommand("secret", {
		description: "Manage in-memory runtime secrets",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed || trimmed === "help") {
				ctx.ui.notify(getHelpText(), "info");
				return;
			}

			if (trimmed === "list") {
				if (secrets.size === 0) {
					ctx.ui.notify("No runtime secrets set.", "info");
					return;
				}

				const names = [...secrets.keys()].sort();
				ctx.ui.notify(`Secrets in memory (${names.length}):\n- ${names.join("\n- ")}`, "info");
				return;
			}

			if (trimmed === "clear") {
				secrets.clear();
				ctx.ui.notify("Cleared all runtime secrets.", "info");
				return;
			}

			const unsetMatch = trimmed.match(/^unset\s+([A-Za-z_][A-Za-z0-9_]*)$/);
			if (unsetMatch) {
				const name = unsetMatch[1];
				const existed = secrets.delete(name);
				ctx.ui.notify(existed ? `Removed ${name}.` : `${name} was not set.`, "info");
				return;
			}

			const setMatch = trimmed.match(/^set\s+([A-Za-z_][A-Za-z0-9_]*)$/);
			if (setMatch) {
				if (!ctx.hasUI) {
					ctx.ui.notify("/secret set requires interactive UI. Use /secret import in non-interactive mode.", "warning");
					return;
				}

				const name = setMatch[1];
				if (!isValidSecretName(name)) {
					ctx.ui.notify(`Invalid secret name: ${name}`, "error");
					return;
				}

				const value = await ctx.ui.input(`Set ${name}`, "Paste secret value");
				if (value === undefined) {
					ctx.ui.notify("Cancelled.", "info");
					return;
				}

				secrets.set(name, value);
				const warning = value.length < MIN_REDACTION_LENGTH ? " (warning: short values may evade redaction)" : "";
				ctx.ui.notify(`Stored ${name} in memory.${warning}`, "info");
				return;
			}

			const importMatch = trimmed.match(/^import\s+([A-Za-z_][A-Za-z0-9_]*)\s+([\s\S]+)$/);
			if (importMatch) {
				const name = importMatch[1];
				const command = importMatch[2];
				if (!isValidSecretName(name)) {
					ctx.ui.notify(`Invalid secret name: ${name}`, "error");
					return;
				}

				const result = await pi.exec("bash", ["-lc", command], { timeout: 30_000 });
				if (result.code !== 0) {
					ctx.ui.notify(`Import command failed (exit ${result.code}).`, "error");
					return;
				}

				const value = result.stdout.trimEnd();
				if (!value) {
					ctx.ui.notify("Import command returned empty stdout.", "error");
					return;
				}

				secrets.set(name, value);
				const warning = value.length < MIN_REDACTION_LENGTH ? " (warning: short values may evade redaction)" : "";
				ctx.ui.notify(`Imported ${name} into memory.${warning}`, "info");
				return;
			}

			ctx.ui.notify(getHelpText(), "warning");
		},
	});
}
