// A large folder: 5000 files in 10 directories. Each directory has 400 text
// files of 20 KB and 100 PDF-like binary files of PDF_MB each.
// Zero store latency: this measures the sandbox, not GCS.
import { AgentOs } from "@rivet-dev/agentos-core";
import { CountingDriver, Tree } from "./lab";

const PDF_MB = Number(process.env.PDF_MB ?? 2);
const pdf = new Uint8Array(PDF_MB * 1024 * 1024);
for (let i = 0; i < pdf.length; i++) pdf[i] = (i * 2654435761) >>> 24;
pdf.set(new TextEncoder().encode("%PDF-1.7\n"));
const tree = new Tree();
const text = `${"lorem ipsum dolor sit amet ".repeat(740)}\n`;
let bytes = 0;
for (let d = 0; d < 10; d++) {
	for (let i = 0; i < 400; i++) {
		tree.put(`d${d}/note-${i}.md`, `${text}${i % 20 === 0 ? "needle\n" : ""}`);
		bytes += text.length;
	}
	for (let i = 0; i < 100; i++) {
		tree.put(`d${d}/deck-${i}.pdf`, "");
		tree.files.set(`d${d}/deck-${i}.pdf`, pdf);
		bytes += pdf.length;
	}
}
console.log(`files ${tree.files.size}, total ${(bytes / 1024 ** 3).toFixed(2)} GB, pdf ${PDF_MB} MB`);
const driver = new CountingDriver(tree);
const vm = await AgentOs.create({ permissions: { network: "deny" }, mounts: [{ path: "/drive", driver: driver.asFs(), readOnly: true }] });
await vm.createContext("js");
const sh = async (label: string, command: string) => {
	driver.reset();
	const t = performance.now();
	const r = await vm.process.exec(command, { timeoutMs: 600_000, output: { capture: "all" } });
	const s = ((performance.now() - t) / 1000).toFixed(1);
	console.log(`| ${label} | ${s} s | ${driver.total()} | ${driver.ops.get("pread") ?? 0} | ${`${r.stdout ?? ""}${r.stderr ?? ""}`.trim().replace(/\n/g, " ").slice(0, 50)} (${r.outcome})`);
};
console.log("| command | time | driver calls | pread calls | output |");
await sh("cat one PDF", "cat /drive/d0/deck-1.pdf | wc -c");
await sh("head -c 1000 of one PDF", "head -c 1000 /drive/d0/deck-2.pdf | wc -c");
await sh("ls one directory (500)", "ls -la /drive/d0 | wc -l");
await sh("find all (5000)", "find /drive -type f | wc -l");
await sh("find -name '*.pdf'", "find /drive -name '*.pdf' | wc -l");
await sh("grep -rl in one directory (400 md + 100 pdf)", "grep -rl needle /drive/d0 | wc -l");
await sh("grep -rl --include='*.md' in one directory", "grep -rl --include='*.md' needle /drive/d0 | wc -l");
if (process.env.FULL) {
	await sh("grep -rl --include='*.md' all (4000 md)", "grep -rl --include='*.md' needle /drive | wc -l");
	await sh("grep -rl all (5000)", "grep -rl needle /drive | wc -l");
}
{
	driver.reset();
	const t = performance.now();
	const r = await vm.javascript.execute(`{const fs=require('fs'),p=require('path');let c=0;const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);if(e.isDirectory())walk(f);else if(f.endsWith('.md')&&fs.readFileSync(f,'utf8').includes('needle'))c++}};walk('/drive');console.log(c)}`, { contextId: "js", format: "commonjs", timeoutMs: 600_000, output: { capture: "all" } });
	console.log(`| fs walk of all md in the JS context (4000 md) | ${((performance.now() - t) / 1000).toFixed(1)} s | ${driver.total()} | ${driver.ops.get("pread") ?? 0} | ${`${r.stdout ?? ""}${r.stderr ?? ""}`.trim().slice(0, 60)}`);
}
await vm.contexts.delete("js").catch(() => {});
await vm.dispose();
process.exit(0);
