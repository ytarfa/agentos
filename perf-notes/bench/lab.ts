// Shared parts of the benchmarks: a counting in-memory js_bridge driver and a timer.
import type { AgentOs, VirtualFileSystem } from "@rivet-dev/agentos-core";

export class Tree {
	readonly files = new Map<string, Uint8Array>();
	readonly dirs = new Map<string, Set<string>>([["", new Set()]]);
	put(path: string, text: string) {
		const parts = path.split("/");
		for (let i = 0; i < parts.length; i++) {
			const parent = parts.slice(0, i).join("/");
			if (!this.dirs.has(parent)) this.dirs.set(parent, new Set());
			this.dirs.get(parent)?.add(parts[i] as string);
		}
		this.files.set(path, new TextEncoder().encode(text));
	}
	static notes(n: number, dir = "notes", bytes = 40): Tree {
		const tree = new Tree();
		const pad = "x".repeat(Math.max(0, bytes - 20));
		for (let i = 0; i < n; i++) {
			tree.put(`${dir}/note-${i}.md`, `note ${i} ${pad}\n${i % 10 === 0 ? "needle\n" : ""}`);
		}
		return tree;
	}
}

export interface DriverHooks {
	// Awaited before the content of a file is returned.
	content?(path: string, tree: Tree): Promise<void> | void;
	// Called when the guest lists a directory.
	listed?(path: string, tree: Tree): void;
}

export class CountingDriver {
	readonly ops = new Map<string, number>();
	readonly trace: string[] = [];
	tracing = false;
	insideMs = 0;
	private readonly inodes = new Map<string, number>();
	constructor(
		readonly tree: Tree,
		private readonly hooks: DriverHooks = {},
	) {}

	reset() {
		this.ops.clear();
		this.trace.length = 0;
		this.insideMs = 0;
	}
	total() {
		return [...this.ops.values()].reduce((a, b) => a + b, 0);
	}
	summary() {
		return [...this.ops].map(([k, v]) => `${k}=${v}`).join(" ");
	}

	asFs(): VirtualFileSystem {
		const norm = (p: string) => p.split("/").filter((s) => s && s !== ".").join("/");
		const err = (code: string, op: string, p: string) => new Error(`${code}: ${op} '${p}'`);
		const count = (op: string, p: string) => {
			this.ops.set(op, (this.ops.get(op) ?? 0) + 1);
			if (this.tracing) this.trace.push(`${op} ${p}`);
		};
		const timed = async <T>(fn: () => Promise<T> | T): Promise<T> => {
			const t = performance.now();
			try {
				return await fn();
			} finally {
				this.insideMs += performance.now() - t;
			}
		};
		const stat = (p: string) => {
			const key = norm(p);
			const file = this.tree.files.get(key);
			const dir = this.tree.dirs.has(key);
			if (!file && !dir) throw err("ENOENT", "stat", p);
			let ino = this.inodes.get(key);
			if (!ino) this.inodes.set(key, (ino = this.inodes.size + 2));
			const size = file?.byteLength ?? 4096;
			return {
				mode: file ? 0o100444 : 0o40555, size, blocks: Math.ceil(size / 512), dev: 1, rdev: 0,
				isDirectory: !file, isSymbolicLink: false, atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0,
				ino, nlink: 1, uid: 0, gid: 0,
			};
		};
		const content = async (p: string, op: string) => {
			const key = norm(p);
			const data = this.tree.files.get(key);
			if (!data) throw err(this.tree.dirs.has(key) ? "EISDIR" : "ENOENT", op, p);
			await this.hooks.content?.(key, this.tree);
			return data;
		};
		const list = (p: string) => {
			const key = norm(p);
			const names = this.tree.dirs.get(key);
			if (!names) throw err("ENOENT", "scandir", p);
			this.hooks.listed?.(key, this.tree);
			return [...names].map((name) => ({
				name,
				isDirectory: this.tree.dirs.has(key ? `${key}/${name}` : name),
			}));
		};
		const refuse = (op: string) => async (p: string): Promise<never> => {
			count(op, p);
			throw err("EROFS", op, p);
		};
		return {
			readFile: (p: string) => timed(() => (count("readFile", p), content(p, "open"))),
			readTextFile: async (p: string) => new TextDecoder().decode(await timed(() => (count("readTextFile", p), content(p, "open")))),
			pread: (p: string, o: number, l: number) => timed(async () => (count("pread", p), (await content(p, "read")).subarray(o, o + l))),
			readDir: (p: string) => timed(() => (count("readDir", p), list(p).map((e) => e.name))),
			readDirWithTypes: (p: string) => timed(() => (count("readDirWithTypes", p), list(p))),
			exists: (p: string) => timed(() => (count("exists", p), this.tree.files.has(norm(p)) || this.tree.dirs.has(norm(p)))),
			stat: (p: string) => timed(() => (count("stat", p), stat(p))),
			lstat: (p: string) => timed(() => (count("lstat", p), stat(p))),
			realpath: (p: string) => timed(() => (count("realpath", p), stat(p), p)),
			readlink: async (p: string): Promise<string> => { count("readlink", p); throw err("EINVAL", "readlink", p); },
			writeFile: refuse("writeFile"), pwrite: refuse("pwrite"), createDir: refuse("createDir"), mkdir: refuse("mkdir"),
			removeFile: refuse("removeFile"), removeDir: refuse("removeDir"), rename: refuse("rename"), symlink: refuse("symlink"),
			link: refuse("link"), chmod: refuse("chmod"), chown: refuse("chown"), utimes: refuse("utimes"), truncate: refuse("truncate"),
		} as unknown as VirtualFileSystem;
	}
}

export async function time(vm: AgentOs, command: string, cwd = "/home/agentos") {
	const started = performance.now();
	const r = await vm.process.exec(command, { cwd, timeoutMs: 120_000, output: { capture: "all" } });
	return {
		ms: Math.round(performance.now() - started),
		out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(),
		exit: r.exitCode,
	};
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
