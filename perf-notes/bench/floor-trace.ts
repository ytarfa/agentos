// Counts the host process trace events of the WASM runner for one guest command.
//   CMD='grep -rl needle /home/agentos/n200 | wc -l' bun floor-trace.ts
import { AgentOs } from "@rivet-dev/agentos-core";
import { Tree } from "./lab";

const n = Number(process.env.N ?? 200);
const command = process.env.CMD || `grep -rl needle /home/agentos/n${n} | wc -l`;
const vm = await AgentOs.create({ permissions: { network: "deny" } });
await vm.mkdir(`/home/agentos/n${n}`, { recursive: true });
await vm.writeFiles([...Tree.notes(n, `n${n}`).files].map(([k, v]) => ({ path: `/home/agentos/${k}`, content: new TextDecoder().decode(v) })));
const started = performance.now();
const r = await vm.process.exec(command, { cwd: "/home/agentos", timeoutMs: 120_000, env: { AGENTOS_TRACE_HOST_PROCESS: "1" }, output: { capture: "all" } });
const counts = new Map<string, number>();
for (const line of (r.stderr ?? "").split("\n")) {
	const m = /^\[agent-os-host-process\] (\S+)/.exec(line);
	if (m) counts.set(m[1] as string, (counts.get(m[1] as string) ?? 0) + 1);
}
console.log(`ms=${Math.round(performance.now() - started)} exit=${r.exitCode} out=${(r.stdout ?? "").trim()}`);
console.log([...counts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" "));
if (process.env.RAW) console.log((r.stderr ?? "").split("\n").slice(0, Number(process.env.RAW)).join("\n"));
await vm.dispose();
process.exit(0);
