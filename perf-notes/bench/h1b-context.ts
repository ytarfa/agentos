// H1b: the retained JS context (runJs) and a traced single-file read.
import { AgentOs } from "@rivet-dev/agentos-core";
import { CountingDriver, Tree, time } from "./lab";

const sizes = [4, 50, 200, 500];
const tree = new Tree();
for (const n of sizes) for (const [k, v] of Tree.notes(n, `n${n}`).files) tree.put(k, new TextDecoder().decode(v));
const driver = new CountingDriver(tree);
const vm = await AgentOs.create({ permissions: { network: "deny" }, mounts: [{ path: "/drive", driver: driver.asFs(), readOnly: true }] });
for (const n of sizes) {
	await vm.mkdir(`/home/agentos/n${n}`, { recursive: true });
	await vm.writeFiles([...tree.files].filter(([k]) => k.startsWith(`n${n}/`)).map(([k, v]) => ({ path: `/home/agentos/${k}`, content: new TextDecoder().decode(v) })));
}
await vm.createContext("js");
for (const root of ["/home/agentos", "/drive"]) {
	for (const n of sizes) {
		const code = `{const fs=require('fs');let c=0;for(const f of fs.readdirSync('${root}/n${n}')){if(fs.readFileSync('${root}/n${n}/'+f,'utf8').includes('needle'))c++}console.log(c)}`;
		let ms = 0;
		for (let i = 0; i < 2; i++) {
			driver.reset();
			const t = performance.now();
			var r = await vm.javascript.execute(code, { contextId: "js", format: "commonjs", output: { capture: "all" } });
			ms = Math.round(performance.now() - t);
		}
		console.log(`runJs ${root} N=${n}: ${ms} ms, calls=${driver.total()} (${driver.summary()}) out=${(r.stdout ?? "").trim()} ${(r.stderr ?? "").trim().slice(0, 100)}`);
	}
}
// async parallel reads in the context
{
	const code = `(async()=>{const fs=require('fs');const d='/drive/n500';const names=fs.readdirSync(d);const t=Date.now();const all=await Promise.all(names.map(f=>fs.promises.readFile(d+'/'+f,'utf8')));console.log(all.filter(s=>s.includes('needle')).length, Date.now()-t)})()`;
	driver.reset();
	const t = performance.now();
	const r = await vm.javascript.execute(code, { contextId: "js", format: "commonjs", output: { capture: "all" } });
	console.log(`runJs promises /drive N=500: ${Math.round(performance.now() - t)} ms, calls=${driver.total()} out=${(r.stdout ?? "").trim()} ${(r.stderr ?? "").trim().slice(0, 200)}`);
}
for (const cmd of ["cat /drive/n4/note-1.md", "grep -l needle /drive/n4/note-0.md", "head -1 /drive/n4/note-1.md"]) {
	await time(vm, cmd);
	driver.reset();
	driver.tracing = true;
	const r = await time(vm, cmd);
	driver.tracing = false;
	console.log(`\n$ ${cmd} [${r.ms} ms] ${driver.total()} calls`);
	console.log(driver.trace.join("\n"));
}
await vm.contexts.delete("js").catch(() => {});
await vm.dispose();
process.exit(0);
