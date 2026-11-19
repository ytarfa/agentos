// H1: where does the time go with zero store latency? Fixed cost per exec,
// cost per file, and driver calls per file, for each guest program.
//   bun h1-floor.ts
import { AgentOs } from "@rivet-dev/agentos-core";
import { CountingDriver, Tree, time } from "./lab";

const sizes = (process.env.SIZES ?? "4,50,200,500").split(",").map(Number);
const tree = new Tree();
for (const n of sizes) for (const [k, v] of Tree.notes(n, `n${n}`, Number(process.env.BYTES ?? 40)).files) tree.put(k, new TextDecoder().decode(v));
const driver = new CountingDriver(tree);
const vm = await AgentOs.create({
	permissions: { network: "deny" },
	mounts: [{ path: "/drive", driver: driver.asFs(), readOnly: true }],
});
for (const n of sizes) {
	await vm.mkdir(`/home/agentos/n${n}`, { recursive: true });
	await vm.writeFiles([...tree.files].filter(([k]) => k.startsWith(`n${n}/`)).map(([k, v]) => ({ path: `/home/agentos/${k}`, content: new TextDecoder().decode(v) })));
}
console.log("which:", (await time(vm, "which rg fd grep find node sh bash; echo; ls /opt/agentos/bin | wc -l")).out.replace(/\n/g, " "));
const node = (d: string) => `node -e "const fs=require('fs');let c=0;for(const f of fs.readdirSync('${d}')){if(fs.readFileSync('${d}/'+f,'utf8').includes('needle'))c++}console.log(c)"`;
const programs: [string, (d: string) => string][] = [
	["true", () => "true"],
	["ls -la", (d) => `ls -la ${d} | wc -l`],
	["find -type f", (d) => `find ${d} -type f | wc -l`],
	["grep -rl", (d) => `grep -rl needle ${d} | wc -l`],
	["grep -l *", (d) => `grep -l needle ${d}/* | wc -l`],
	["cat * | grep -c", (d) => `cat ${d}/* | grep -c needle`],
	["rg -l", (d) => `rg -l needle ${d} | wc -l`],
	["node fs loop", node],
];
await time(vm, "true");
for (const [where, root] of [["vm disk", "/home/agentos"], ["js driver", "/drive"]] as const) {
	console.log(`\n=== ${where}`);
	console.log(`| program | ${sizes.map((n) => `N=${n} ms`).join(" | ")} | ms/file | calls/file | driver ms (N max) |`);
	for (const [name, make] of programs) {
		const row: number[] = [];
		let calls = 0, inside = 0, out = "";
		for (const n of sizes) {
			await time(vm, make(`${root}/n${n}`));
			driver.reset();
			const r = await time(vm, make(`${root}/n${n}`));
			row.push(r.ms);
			calls = driver.total();
			inside = driver.insideMs;
			out = r.out.slice(0, 40).replace(/\n/g, " ");
		}
		const nMax = sizes.at(-1) as number, nMin = sizes[0] as number;
		const slope = ((row.at(-1) as number) - (row[0] as number)) / (nMax - nMin);
		console.log(`| ${name} | ${row.join(" | ")} | ${slope.toFixed(2)} | ${(calls / nMax).toFixed(1)} | ${inside.toFixed(0)} | ${out}`);
		if (where === "js driver" && process.env.OPS) console.log(`   ${driver.summary()}`);
	}
}
// The retained JS context that the agent uses for runJs.
await vm.createContext("js");
for (const root of ["/home/agentos", "/drive"]) {
	for (const n of sizes) {
		const code = `const fs=require('fs');let c=0;for(const f of fs.readdirSync('${root}/n${n}')){if(fs.readFileSync('${root}/n${n}/'+f,'utf8').includes('needle'))c++}console.log(c)`;
		driver.reset();
		const t = performance.now();
		const r = await vm.javascript.execute(code, { contextId: "js", format: "commonjs", output: { capture: "all" } });
		console.log(`runJs context ${root} N=${n}: ${Math.round(performance.now() - t)} ms, calls=${driver.total()} out=${(r.stdout ?? "").trim()} ${(r.stderr ?? "").trim().slice(0, 100)}`);
	}
}
await vm.dispose();
process.exit(0);
