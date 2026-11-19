// How large can one directory be? VM disk against the JS driver.
import { AgentOs } from "@rivet-dev/agentos-core";
import { CountingDriver, Tree, time } from "./lab";
const sizes = (process.env.SIZES ?? "1000,2000,3000,5000").split(",").map(Number);
const tree = new Tree();
for (const n of sizes) for (const [k, v] of Tree.notes(n, `n${n}`).files) tree.put(k, new TextDecoder().decode(v));
const driver = new CountingDriver(tree);
const vm = await AgentOs.create({ permissions: { network: "deny" }, mounts: [{ path: "/drive", driver: driver.asFs(), readOnly: true }] });
for (const n of sizes) {
	await vm.mkdir(`/home/agentos/n${n}`, { recursive: true });
	const all = [...tree.files].filter(([k]) => k.startsWith(`n${n}/`)).map(([k, v]) => ({ path: `/home/agentos/${k}`, content: new TextDecoder().decode(v) }));
	for (let i = 0; i < all.length; i += 500) await vm.writeFiles(all.slice(i, i + 500));
}
for (const root of ["/home/agentos", "/drive"]) {
	for (const n of sizes) {
		for (const c of [`ls ${root}/n${n} | wc -l`, `find ${root}/n${n} -type f | wc -l`, `grep -rl needle ${root}/n${n} | wc -l`, `node -e "console.log(require('fs').readdirSync('${root}/n${n}').length)"`]) {
			const r = await time(vm, c);
			console.log(`${c.slice(0, 60).padEnd(60)} ${String(r.ms).padStart(6)} ms  ${r.out.replace(/\n/g, " | ").slice(0, 90)}`);
		}
	}
}
await vm.dispose(); process.exit(0);
