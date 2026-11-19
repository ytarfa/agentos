// Correctness of the patched sidecar with the attribute cache.
import { AgentOs } from "@rivet-dev/agentos-core";
import { CountingDriver, Tree, sleep, time } from "./lab";
const tree = Tree.notes(20, "n20");
tree.put("deep/a/b/c.txt", "deep file\n");
const driver = new CountingDriver(tree);
const vm = await AgentOs.create({ permissions: { network: "deny" }, mounts: [{ path: "/drive", driver: driver.asFs(), readOnly: true }] });
const run = async (c: string) => {
	driver.reset();
	const r = await time(vm, c);
	console.log(`$ ${c}  [${r.ms} ms, exit ${r.exit}, ${driver.total()} calls: ${driver.summary()}]\n${r.out}\n`);
};
await run("ls /drive /drive/n20 | wc -l");
await run("cat /drive/n20/note-0.md /drive/deep/a/b/c.txt");
await run("grep -rl needle /drive | sort | head -3; find /drive -type f | wc -l");
await run(`node -e "const fs=require('fs');console.log(fs.statSync('/drive/n20/note-1.md').size, fs.existsSync('/drive/nope'), fs.readdirSync('/drive/deep/a'))"`);
await run("cat /drive/n20/new.md; echo exit=$?");
tree.put("n20/new.md", "created on the host\n");
await run("cat /drive/n20/new.md; echo exit=$? # immediately after the host created the file");
await sleep(Number(process.env.AGENTOS_JS_BRIDGE_ATTR_CACHE_MS ?? 0) + 200);
await run("cat /drive/n20/new.md; echo exit=$? # after the cache lifetime");
await run("echo x > /drive/n20/w.md; echo exit=$?; rm /drive/n20/note-0.md; echo exit=$?");
await vm.dispose();
process.exit(0);
