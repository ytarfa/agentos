// H2: other guest programs (rg, fd from the registry) and other mount types
// (host_dir on a local directory), with zero store latency.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { AgentOs, hostDirMount } from "@rivet-dev/agentos-core";
import { CountingDriver, Tree, time } from "./lab";

const sizes = [4, 200, 500];
const tree = new Tree();
for (const n of sizes) for (const [k, v] of Tree.notes(n, `n${n}`).files) tree.put(k, new TextDecoder().decode(v));
const hostRoot = `${process.env.TMPDIR}/speed-hostdir`;
rmSync(hostRoot, { recursive: true, force: true });
for (const [k, v] of tree.files) {
	mkdirSync(`${hostRoot}/${k.split("/")[0]}`, { recursive: true });
	writeFileSync(`${hostRoot}/${k}`, v);
}
const driver = new CountingDriver(tree);
const vm = await AgentOs.create({
	permissions: { network: "deny" },
	software: [{ registry: "ripgrep" }, { registry: "fd" }],
	mounts: [
		{ path: "/drive", driver: driver.asFs(), readOnly: true },
		hostDirMount("/hostdir", hostRoot, { readOnly: true }),
	],
});
for (const n of sizes) {
	await vm.mkdir(`/home/agentos/n${n}`, { recursive: true });
	await vm.writeFiles([...tree.files].filter(([k]) => k.startsWith(`n${n}/`)).map(([k, v]) => ({ path: `/home/agentos/${k}`, content: new TextDecoder().decode(v) })));
}
console.log((await time(vm, "which rg fd; rg --version | head -1")).out);
const programs: [string, (d: string) => string][] = [
	["grep -rl", (d) => `grep -rl needle ${d} | wc -l`],
	["rg -l", (d) => `rg -l needle ${d} | wc -l`],
	["rg -l -j1", (d) => `rg -l -j1 needle ${d} | wc -l`],
	["find -type f", (d) => `find ${d} -type f | wc -l`],
	["fd -t f", (d) => `fd -t f . ${d} | wc -l`],
	["cat one", (d) => `cat ${d}/note-1.md | wc -l`],
];
for (const [where, root] of [["vm disk", "/home/agentos"], ["js driver", "/drive"], ["host_dir local", "/hostdir"]] as const) {
	console.log(`\n=== ${where}`);
	console.log(`| program | ${sizes.map((n) => `N=${n}`).join(" | ")} | ms/file | calls/file |`);
	for (const [name, make] of programs) {
		const row: number[] = [];
		let calls = 0, out = "";
		for (const n of sizes) {
			await time(vm, make(`${root}/n${n}`));
			driver.reset();
			const r = await time(vm, make(`${root}/n${n}`));
			row.push(r.ms);
			calls = driver.total();
			out = r.out.slice(0, 60).replace(/\n/g, " ");
		}
		const slope = ((row.at(-1) as number) - (row[0] as number)) / ((sizes.at(-1) as number) - (sizes[0] as number));
		console.log(`| ${name} | ${row.join(" | ")} | ${slope.toFixed(2)} | ${(calls / (sizes.at(-1) as number)).toFixed(1)} | ${out}`);
	}
}
await vm.dispose();
process.exit(0);
