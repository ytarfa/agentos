// Runs one guest command in a loop on the VM disk, so that a profiler can sample the sidecar.
//   CMD='grep -rl needle /home/agentos/n500 | wc -l' SECONDS_TO_RUN=15 bun floor-loop.ts
import { AgentOs } from "@rivet-dev/agentos-core";
import { Tree, time } from "./lab";

const n = Number(process.env.N ?? 500);
const command = process.env.CMD ?? `grep -rl needle /home/agentos/n${n} | wc -l`;
const seconds = Number(process.env.SECONDS_TO_RUN ?? 15);
const vm = await AgentOs.create({ permissions: { network: "deny" } });
await vm.mkdir(`/home/agentos/n${n}`, { recursive: true });
await vm.writeFiles([...Tree.notes(n, `n${n}`).files].map(([k, v]) => ({ path: `/home/agentos/${k}`, content: new TextDecoder().decode(v) })));
await time(vm, "true");
console.log("READY");
const end = performance.now() + seconds * 1000;
const all: number[] = [];
let out = "";
while (performance.now() < end) {
	const r = await time(vm, command);
	all.push(r.ms);
	out = r.out;
}
all.sort((a, b) => a - b);
console.log(`runs=${all.length} min=${all[0]} median=${all[Math.floor(all.length / 2)]} out=${out.slice(0, 60)}`);
await vm.dispose();
process.exit(0);
