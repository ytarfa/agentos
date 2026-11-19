// Runs one guest command a fixed number of times on the VM disk. Use it with a trace of the sidecar.
//   CMD='grep -rl needle /home/agentos/n500 | wc -l' RUNS=1 bun floor-once.ts
import { AgentOs } from "@rivet-dev/agentos-core";
import { Tree, time } from "./lab";

const n = Number(process.env.N ?? 500);
const command = process.env.CMD || `grep -rl needle /home/agentos/n${n} | wc -l`;
const runs = Number(process.env.RUNS ?? 1);
const vm = await AgentOs.create({ permissions: { network: "deny" } });
await vm.mkdir(`/home/agentos/n${n}`, { recursive: true });
await vm.writeFiles([...Tree.notes(n, `n${n}`).files].map(([k, v]) => ({ path: `/home/agentos/${k}`, content: new TextDecoder().decode(v) })));
console.log("READY");
for (let i = 0; i < runs; i++) {
	const r = await time(vm, command);
	console.log(`run ${i}: ${r.ms} ms exit=${r.exit} out=${r.out.slice(0, 80)}`);
}
await vm.dispose();
process.exit(0);
