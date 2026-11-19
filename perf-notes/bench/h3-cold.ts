// H3: cold store latency. Compares no read-ahead, read-ahead when the guest
// lists a directory, read-ahead when the guest reads a second file of a
// directory, and a warm process-wide cache.
//   LATENCY=30 bun h3-cold.ts
import { AgentOs } from "@rivet-dev/agentos-core";
import { CountingDriver, Tree, sleep, time } from "./lab";

const LATENCY = Number(process.env.LATENCY ?? 30);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 32);
const sizes = [4, 50, 200, 500];

// A content cache for the whole process. The key would be bucket + object +
// generation in a real design, so all conversations share one entry.
class SharedCache {
	private readonly entries = new Map<string, Promise<void>>();
	storeReads = 0;
	inFlight = 0;
	private waiting: (() => void)[] = [];
	clear() { this.entries.clear(); this.storeReads = 0; }
	has(key: string) { return this.entries.has(key); }
	load(key: string): Promise<void> {
		let entry = this.entries.get(key);
		if (!entry) this.entries.set(key, (entry = this.fetch()));
		return entry;
	}
	private async fetch() {
		while (this.inFlight >= CONCURRENCY) await new Promise<void>((r) => this.waiting.push(r));
		this.inFlight++;
		this.storeReads++;
		await sleep(LATENCY);
		this.inFlight--;
		this.waiting.shift()?.();
	}
}

type Strategy = "none" | "on-list" | "on-second-read";
const cache = new SharedCache();
let strategy: Strategy = "none";
const readsInDir = new Map<string, number>();
const tree = new Tree();
for (const n of sizes) for (const [k, v] of Tree.notes(n, `n${n}`).files) tree.put(k, new TextDecoder().decode(v));
const ahead = (dir: string) => {
	for (const name of tree.dirs.get(dir) ?? []) {
		const key = `${dir}/${name}`;
		if (tree.files.has(key)) void cache.load(key);
	}
};
const driver = new CountingDriver(tree, {
	listed(dir) { if (strategy === "on-list") ahead(dir); },
	async content(key) {
		const dir = key.slice(0, key.lastIndexOf("/"));
		if (strategy === "on-second-read" && !cache.has(key)) {
			const n = (readsInDir.get(dir) ?? 0) + 1;
			readsInDir.set(dir, n);
			if (n === 2) ahead(dir);
		}
		await cache.load(key);
	},
});
const vm = await AgentOs.create({ permissions: { network: "deny" }, mounts: [{ path: "/drive", driver: driver.asFs(), readOnly: true }] });
await time(vm, "true");
const commands: [string, (d: string) => string][] = [
	["grep -rl", (d) => `grep -rl needle ${d} | wc -l`],
	["cat one file", (d) => `cat ${d}/note-1.md | wc -l`],
	["ls -la", (d) => `ls -la ${d} | wc -l`],
];
console.log(`store latency ${LATENCY} ms, read-ahead concurrency ${CONCURRENCY}`);
for (const [name, make] of commands) {
	console.log(`\n### ${name}\n| strategy | ${sizes.map((n) => `N=${n} ms (store reads)`).join(" | ")} |`);
	for (const s of ["none", "on-list", "on-second-read", "warm cache"] as const) {
		const cells: string[] = [];
		for (const n of sizes) {
			if (s !== "warm cache") { cache.clear(); readsInDir.clear(); strategy = s; }
			else { cache.clear(); strategy = "none"; ahead(`n${n}`); await sleep(LATENCY * (n / CONCURRENCY + 2)); cache.storeReads = 0; }
			const r = await time(vm, make(`/drive/n${n}`));
			await sleep(LATENCY * (n / CONCURRENCY + 2));
			cells.push(`${r.ms} (${cache.storeReads})`);
		}
		console.log(`| ${s} | ${cells.join(" | ")} |`);
	}
}
await vm.dispose();
process.exit(0);
