/**
 * Storage backends for the experiment log.
 *
 * The log is a directory tree of markdown + generated HTML. Two backends:
 *  - LocalBackend:  a plain directory on disk.
 *  - SpaceBackend:  a git clone of a HuggingFace Space; mutations pull-rebase
 *                   then commit+push so multiple agents/people can collaborate.
 *
 * Both expose the same async file API rooted at a local working directory.
 */

import fs from "node:fs/promises";
import path from "node:path";

/** Minimal shape of pi.exec we depend on. */
export type Exec = (
	command: string,
	args: string[],
	options?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;

export interface Backend {
	/** Absolute path to the local working root (the dir we read/write under). */
	readonly root: string;
	/** Human-readable description of where the log lives. */
	describe(): string;
	/** Fetch latest state (no-op for local). */
	pullLatest(): Promise<void>;
	/** Persist any changes (no-op for local; commit+push for Space). */
	commitAndPush(message: string): Promise<void>;

	readFile(rel: string): Promise<string | null>;
	writeFile(rel: string, content: string): Promise<void>;
	exists(rel: string): Promise<boolean>;
	/** Names of immediate subdirectories of `rel`. */
	listDirs(rel: string): Promise<string[]>;
	mkdirp(rel: string): Promise<void>;
}

async function readFileSafe(abs: string): Promise<string | null> {
	try {
		return await fs.readFile(abs, "utf-8");
	} catch {
		return null;
	}
}

async function listSubdirs(abs: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(abs, { withFileTypes: true });
		return entries.filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return [];
	}
}

export class LocalBackend implements Backend {
	readonly root: string;
	constructor(root: string) {
		this.root = path.resolve(root);
	}
	describe(): string {
		return `local: ${this.root}`;
	}
	async pullLatest(): Promise<void> {}
	async commitAndPush(_message: string): Promise<void> {}

	readFile(rel: string): Promise<string | null> {
		return readFileSafe(path.join(this.root, rel));
	}
	async writeFile(rel: string, content: string): Promise<void> {
		const abs = path.join(this.root, rel);
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, content, "utf-8");
	}
	async exists(rel: string): Promise<boolean> {
		try {
			await fs.access(path.join(this.root, rel));
			return true;
		} catch {
			return false;
		}
	}
	listDirs(rel: string): Promise<string[]> {
		return listSubdirs(path.join(this.root, rel));
	}
	async mkdirp(rel: string): Promise<void> {
		await fs.mkdir(path.join(this.root, rel), { recursive: true });
	}
}

/**
 * Space backend: maintains a git clone of a HuggingFace Space under a cache dir.
 * Creates the (static) Space if it does not yet exist.
 */
export class SpaceBackend implements Backend {
	readonly root: string;
	private readonly spaceId: string;
	private readonly exec: Exec;
	private initialized = false;

	constructor(spaceId: string, cacheDir: string, exec: Exec) {
		this.spaceId = spaceId;
		this.exec = exec;
		this.root = path.join(cacheDir, spaceId.replace(/[^a-zA-Z0-9._-]/g, "_"));
	}

	describe(): string {
		return `space: ${this.spaceId} (clone at ${this.root})`;
	}

	private async token(): Promise<string | null> {
		const r = await this.exec("hf", ["auth", "token"]);
		const t = r.code === 0 ? r.stdout.trim() : "";
		return t || process.env.HF_TOKEN || process.env.HUGGINGFACE_HUB_TOKEN || null;
	}

	private async remoteUrl(): Promise<string> {
		const token = await this.token();
		const auth = token ? `user:${token}@` : "";
		return `https://${auth}huggingface.co/spaces/${this.spaceId}`;
	}

	/** Clone the Space (creating it if missing). Idempotent. */
	async ensureClone(): Promise<void> {
		if (this.initialized) return;
		const gitDir = path.join(this.root, ".git");
		try {
			await fs.access(gitDir);
			this.initialized = true;
			return;
		} catch {
			// not cloned yet
		}

		// Create the Space if it doesn't exist (static SDK). exist-ok via --exist-ok flag.
		await this.exec("hf", [
			"repo",
			"create",
			this.spaceId,
			"--type",
			"space",
			"--space-sdk",
			"static",
			"--exist-ok",
		]);

		await fs.mkdir(path.dirname(this.root), { recursive: true });
		const url = await this.remoteUrl();
		const clone = await this.exec("git", ["clone", url, this.root]);
		if (clone.code !== 0) {
			throw new Error(`git clone of Space ${this.spaceId} failed: ${clone.stderr}`);
		}
		// Make sure commits have an identity even on a bare environment.
		await this.exec("git", ["config", "user.email", "pi-experiment-log@local"], { cwd: this.root });
		await this.exec("git", ["config", "user.name", "pi experiment-log"], { cwd: this.root });
		this.initialized = true;
	}

	async pullLatest(): Promise<void> {
		await this.ensureClone();
		await this.exec("git", ["pull", "--rebase", "--autostash"], { cwd: this.root });
	}

	async commitAndPush(message: string): Promise<void> {
		await this.ensureClone();
		await this.exec("git", ["add", "-A"], { cwd: this.root });
		const status = await this.exec("git", ["status", "--porcelain"], { cwd: this.root });
		if (status.stdout.trim().length === 0) return; // nothing to commit
		await this.exec("git", ["commit", "-m", message], { cwd: this.root });
		const push = await this.exec("git", ["push"], { cwd: this.root });
		if (push.code !== 0) {
			// Try once more after a rebase in case someone pushed concurrently.
			await this.exec("git", ["pull", "--rebase", "--autostash"], { cwd: this.root });
			await this.exec("git", ["push"], { cwd: this.root });
		}
	}

	async readFile(rel: string): Promise<string | null> {
		await this.ensureClone();
		return readFileSafe(path.join(this.root, rel));
	}
	async writeFile(rel: string, content: string): Promise<void> {
		await this.ensureClone();
		const abs = path.join(this.root, rel);
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, content, "utf-8");
	}
	async exists(rel: string): Promise<boolean> {
		await this.ensureClone();
		try {
			await fs.access(path.join(this.root, rel));
			return true;
		} catch {
			return false;
		}
	}
	async listDirs(rel: string): Promise<string[]> {
		await this.ensureClone();
		return listSubdirs(path.join(this.root, rel));
	}
	async mkdirp(rel: string): Promise<void> {
		await this.ensureClone();
		await fs.mkdir(path.join(this.root, rel), { recursive: true });
	}
}
