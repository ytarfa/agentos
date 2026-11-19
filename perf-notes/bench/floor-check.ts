// Runs guest commands that check the behaviour of the VM disk and of child processes.
// Run it with two sidecar binaries and compare the two result files.
//   AGENTOS_SIDECAR_BIN=... OUT=/tmp/a.json bun floor-check.ts
import { writeFileSync } from "node:fs";
import { AgentOs } from "@rivet-dev/agentos-core";
import { Tree } from "./lab";

const vm = await AgentOs.create({ permissions: { network: "deny" } });
const home = "/home/agentos";
await vm.mkdir(`${home}/n20`, { recursive: true });
await vm.writeFiles([...Tree.notes(20, "n20").files].map(([k, v]) => ({ path: `${home}/${k}`, content: new TextDecoder().decode(v) })));
await vm.writeFile(`${home}/big.txt`, "0123456789abcdef".repeat(4096 * 4));

const normalize = (text: string) =>
	text
		.replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +\d+ +[\d:]+/g, "DATE")
		.replace(/\d{4}-\d{2}-\d{2}[ T][\d:.]+( [+-]\d{4})?/g, "DATE")
		.replace(/\b\d{10,}(\.\d+)?\b/g, "EPOCH");

const results: Record<string, { exit: number | null; out: string; err: string }> = {};
const timings: Record<string, number> = {};
async function run(name: string, command: string) {
	const started = performance.now();
	const r = await vm.process.exec(command, { cwd: home, timeoutMs: 60_000, output: { capture: "all" } });
	timings[name] = Math.round(performance.now() - started);
	results[name] = { exit: r.exitCode ?? null, out: normalize(r.stdout ?? ""), err: normalize(r.stderr ?? "") };
}

// Reads.
await run("ls-la", "ls -la n20");
await run("ls-la-pipe", "ls -la n20 | wc -l");
await run("cat-one", "cat n20/note-10.md");
await run("cat-big-size", "cat big.txt | wc -c");
await run("cat-big-direct", "cat big.txt");
await run("grep-r", "grep -r needle n20 | sort");
await run("grep-rl", "grep -rl needle n20 | sort");
await run("find", "find n20 -type f | sort");
await run("stat", "stat -c '%n %s %a %F' n20 n20/note-1.md big.txt");
await run("node-fs", `node -e "const fs=require('fs');const d='${home}/n20';const o=fs.readdirSync(d).sort().map(f=>{const s=fs.statSync(d+'/'+f);return [f,s.size,s.mode.toString(8),s.isFile(),fs.readFileSync(d+'/'+f,'utf8').length]});console.log(JSON.stringify(o))"`);
await run("missing", "cat n20/none.md; echo code=$?");
await run("ls-missing", "ls /nonexistent; echo code=$?");

// Writes that later calls must see at once.
await run("write-read", "echo one > w.txt; cat w.txt; echo two >> w.txt; cat w.txt; ls w.txt");
await run("overwrite", "echo three > w.txt; cat w.txt; stat -c '%s' w.txt");
await run("rename", "mv w.txt w2.txt; ls w.txt; echo code=$?; cat w2.txt");
await run("delete", "rm w2.txt; cat w2.txt; echo code=$?; ls | sort");
await run("mkdir-rmdir", "mkdir -p d1/d2/d3; echo x > d1/d2/d3/f; find d1 | sort; rm -r d1; ls d1; echo code=$?");
await run("file-to-dir", "echo x > k; cat k; rm k; mkdir k; echo y > k/inner; cat k/inner; ls -la k | wc -l; rm -r k; echo z > k; cat k; rm k");
await run("rename-dir", "mkdir -p r1/sub; echo x > r1/sub/f; mv r1 r2; cat r2/sub/f; cat r1/sub/f; echo code=$?; rm -r r2");
await run("many-in-one", "for i in 1 2 3 4 5 6 7 8; do echo $i > m$i; cat m$i; rm m$i; cat m$i 2>/dev/null; echo c=$?; done");
await vm.writeFile(`${home}/host.txt`, "from host\n");
await run("host-write-guest-read", "cat host.txt; echo guest >> host.txt");
results["guest-write-host-read"] = { exit: 0, out: new TextDecoder().decode(await vm.readFile(`${home}/host.txt`)), err: "" };
await vm.move(`${home}/host.txt`, `${home}/host2.txt`).catch((e: unknown) => { results["host-move-error"] = { exit: 1, out: "", err: String(e) }; });
await run("host-rename-guest-sees", "cat host.txt; echo code=$?; cat host2.txt; echo code=$?");
await vm.remove(`${home}/host2.txt`).catch((e: unknown) => { results["host-delete-error"] = { exit: 1, out: "", err: String(e) }; });
await run("host-delete-guest-sees", "cat host2.txt; echo code=$?");

// Symlinks.
await run("symlink-file", "echo target1 > t1; echo target2 > t2; ln -s t1 link; cat link; readlink link; ls -la link; rm link; ln -s t2 link; cat link; readlink link");
await run("symlink-retarget-dir", "mkdir da db; echo a > da/f; echo b > db/f; ln -s da cur; cat cur/f; rm cur; ln -s db cur; cat cur/f; ls cur; rm cur; cat cur/f; echo code=$?");
await run("symlink-dangling", "ln -s nowhere dang; cat dang; echo code=$?; ls -la dang; readlink dang; echo made > nowhere; cat dang; rm dang nowhere");
await run("symlink-loop", "ln -s loopb loopa; ln -s loopa loopb; cat loopa; echo code=$?; rm loopa loopb");
await run("symlink-relative", "mkdir -p s/a s/b; echo deep > s/b/f; ln -s ../b/f s/a/l; cat s/a/l; cat s/a/../b/f; rm -r s");
await run("symlink-abs-dir", `ln -s ${home}/n20 absdir; ls absdir | wc -l; cat absdir/note-0.md; find -L absdir -type f | wc -l; rm absdir`);
await run("hardlink", "echo hl > h1; ln h1 h2; echo more >> h2; cat h1; stat -c '%h' h1; rm h1; cat h2; rm h2");

// Lower layer, whiteouts and the reserved overlay namespace.
await run("lower-delete", "ls /etc/hostname; cat /etc/hostname; rm /etc/hostname; cat /etc/hostname; echo code=$?; ls /etc | grep -c hostname; echo back > /etc/hostname; cat /etc/hostname");
await run("lower-dir-replace", "ls /usr/share >/dev/null; echo code=$?; mkdir -p /opt/x/y; rm -r /opt/x; ls /opt/x; echo code=$?; mkdir /opt/x; ls -la /opt/x | wc -l");
await run("overlay-hidden", "ls /.agentos-overlay; echo code=$?; ls -a / | grep -c agentos-overlay; ln -s /.agentos-overlay ov; ls ov; echo code=$?; ln -s / rootl; ls rootl/.agentos-overlay; echo code=$?; cat rootl/etc/hostname; rm ov rootl");
await run("whiteout-then-symlink-probe", "echo gone > wh; rm wh; ln -s / rl; ls rl/.agentos-overlay/whiteouts; echo code=$?; rm rl");

// Permissions.
await run("id", "id");
await run("chmod-file", "echo secret > p; chmod 000 p; cat p; echo code=$?; stat -c '%a' p; chmod 644 p; cat p; rm p");
await run("chmod-dir", "mkdir pd; echo in > pd/f; chmod 000 pd; cat pd/f; echo code=$?; ls pd; echo code=$?; chmod 755 pd; cat pd/f; rm -r pd");
await run("readonly-dir-write", "mkdir ro; chmod 555 ro; echo x > ro/f; echo code=$?; chmod 755 ro; rmdir ro");
// The chmod program fails on 0.4.8 without the patch too, so Node applies the modes.
await run("node-chmod-file", `echo secret > np; node -e "const fs=require('fs');const p='${home}/np';fs.chmodSync(p,0o000);console.log((fs.statSync(p).mode&0o777).toString(8));try{console.log(fs.readFileSync(p,'utf8'))}catch(e){console.log(e.code)}"; cat np; echo code=$?; node -e "require('fs').chmodSync('${home}/np',0o644)"; cat np; rm np`);
await run("node-chmod-dir", `mkdir npd; echo in > npd/f; node -e "require('fs').chmodSync('${home}/npd',0o000)"; cat npd/f; echo code=$?; ls npd; echo code=$?; echo y > npd/g; echo code=$?; node -e "require('fs').chmodSync('${home}/npd',0o755)"; cat npd/f; ls npd; rm -r npd`);
await run("node-chmod-parent-then-symlink", `mkdir -p q/in; echo v > q/in/f; ln -s q/in ql; cat ql/f; node -e "require('fs').chmodSync('${home}/q',0o000)"; cat ql/f; echo code=$?; node -e "require('fs').chmodSync('${home}/q',0o755)"; cat ql/f; rm -r q ql`);
await run("root-owned", "echo x > /etc/passwd; echo code=$?; touch /root/x; echo code=$?");

// Long path (longer than the cache key limit).
const longName = "L".repeat(120);
await run("long-path", `mkdir -p ${longName}/${longName}/${longName}; echo long > ${longName}/${longName}/${longName}/f; cat ${longName}/${longName}/${longName}/f; rm -r ${longName}; ls ${longName}; echo code=$?`);

// Child processes, pipes, exit codes and signals.
await run("exit-codes", "false; echo $?; sh -c 'exit 3'; echo $?; grep nomatch n20/note-1.md; echo $?");
await run("pipe-chain", "echo hi | cat | cat | wc -c");
await run("sigpipe", "yes | head -n 2000 | wc -l");
await run("subst", "x=$(cat n20/note-0.md | wc -l); echo got=$x; y=$(ls n20 | wc -l); echo $y");
await run("heredoc", "cat <<EOF | wc -c\nline one\nline two\nEOF");
await run("stderr-relay", "ls /nonexistent-a /nonexistent-b n20/note-1.md");
await run("background-wait", "(sleep 0.2; echo late) & echo early; wait; echo done");
await run("kill-child", "sleep 30 & pid=$!; kill $pid; wait $pid; echo code=$?");
await run("nested-sh", `sh -c "sh -c 'ls n20 | wc -l'"`);
await run("seq-big", "seq 1 20000 | tail -n 1; seq 1 20000 | wc -l");
await run("seq-direct", "seq 1 5000");
await run("loop-short", "i=0; while [ $i -lt 15 ]; do ls n20 > /dev/null; i=$((i+1)); done; echo $i");
await run("node-spawn-wasm", `node -e "const cp=require('child_process');console.log(cp.execSync('ls ${home}/n20 | wc -l').toString().trim());console.log(cp.spawnSync('cat',['${home}/n20/note-0.md']).stdout.toString())"`);
await run("sleep-then-output", "echo a; sleep 0.05; echo b; sleep 0.05; echo c");
await run("exit-fast-child", "i=0; while [ $i -lt 10 ]; do /opt/agentos/bin/true; i=$((i+1)); done; echo $i");

writeFileSync(process.env.OUT ?? "/dev/stdout", JSON.stringify({ results, timings }, null, 1));
console.log(`checks=${Object.keys(results).length} total_ms=${Object.values(timings).reduce((a, b) => a + b, 0)}`);
await vm.dispose();
process.exit(0);
