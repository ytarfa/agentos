# Sidecar performance work on agentOS 0.4.8

This document records a performance investigation of the agentOS sidecar and the patches that came from it. It is a handoff: a person who did not do the work can continue from here.

Nothing in this branch is sent to Rivet. The branch lives in a personal fork so that the work can move between machines. Section 9 says which parts fit an upstream pull request and what each part still needs.

## 1. Summary

A guest program such as `grep` was slow for each file that it opened. The cause was in the sidecar, not in the WASM programs.

`grep -rl needle <dir>` over 500 small files, on macOS arm64, zero store latency:

| Sidecar | VM disk | `js_bridge` mount | `js_bridge` mount, ms per file |
|---|---|---|---|
| Published 0.4.8 | 1383 ms | 1663 ms | 3.00 |
| Attribute cache commit only | 1363 ms | 983 ms | 1.67 |
| The five other commits only | 500 ms | 1430 ms | 2.56 |
| All six commits | 482 ms | 503 ms | 0.70 |

The fixed cost of each `exec` (about 80 ms) is not changed.

## 2. Where everything is

| Item | Location |
|---|---|
| Base | Branch `base/v0.4.8`, commit `e57c6aa3b`. This is the source of the published 0.4.8 packages. |
| The work | Branch `perf/0.4.8-sidecar-floor`: six code commits and this directory. |
| Benchmarks and checks | `perf-notes/bench/` |
| Upstream | Remote `upstream` = `https://github.com/rivet-dev/agentos`. Relevant branches: `main`, `rc/perf-batch`. |

### A trap with the tags

The git tags `v0.4.8` and `v0.4.9-rc.1` both point to `e57c6aa3b`. The npm package `0.4.9-rc.1` was published from a different commit, `e3b9aaa00cd7532f77945fe7a4f6fd814eaf4e61`, which is on `rc/perf-batch`.

A sidecar built from one source does not work with the TypeScript client of the other. The client fails at start with `SidecarProcessExited: sidecar process exited with disconnect`, and the sidecar logs `ordinary request ingress closed`. Always pair a sidecar build with the client of the same commit.

## 3. How to build and run

Requirements: Rust (stable, through `rustup`), Node 20 or later, pnpm 10, and Bun 1.4 for the benchmark scripts.

```bash
# In the repository root. The V8 bridge build script needs these packages.
# Without them the cargo build panics with "missing Node dependencies".
pnpm install --filter @rivet-dev/agentos-build-tools... --frozen-lockfile

# The first build takes about 10 minutes. An incremental build takes about 1 minute.
CARGO_TARGET_DIR="$PWD/target" cargo build --release -p agentos-native-sidecar
```

The published TypeScript client loads a custom sidecar through an environment variable. No package change is necessary:

```bash
cd perf-notes/bench
bun install
export AGENTOS_SIDECAR_BIN="$PWD/../../target/release/agentos-native-sidecar"
export AGENTOS_JS_BRIDGE_ATTR_CACHE_MS=2000   # switches the attribute cache on
SIZES=4,200,500 bun h1-floor.ts 2>&1 | grep -E "^(===|\| )"
```

Run the same command without `AGENTOS_SIDECAR_BIN` to measure the published sidecar.

### Linux build

This pattern works for a Linux binary on a Mac:

1. Start `rust:1-bookworm` with the source mounted read-only and with named volumes for the target directory and the cargo registry.
2. Install `nodejs npm clang cmake pkg-config libssl-dev`, then `npm i -g pnpm@10.13.1`.
3. Copy the source without `target`, `node_modules` and `.git`, run the `pnpm install` command above, then the cargo build.
4. Run the benchmarks in `oven/bun:1.4` with the binary mounted and `AGENTOS_SIDECAR_BIN` set.

### Environment variables that the patches add

| Variable | Default | Effect |
|---|---|---|
| `AGENTOS_JS_BRIDGE_ATTR_CACHE_MS` | off | Lifetime in milliseconds of cached `stat`, `lstat`, `realpath` and `exists` answers on `js_bridge` mounts. |
| `AGENTOS_WASM_IDLE_CHILD_PARK` | off | With `1`, a WASM parent that only waits for children sleeps 0.25 to 1 ms between poll sweeps. |

The sidecar reads both from its own environment. The client passes the environment of the host process to the sidecar.

## 4. The problem

The starting point was a `js_bridge` mount that shows cloud storage objects as files, so that an agent can use `ls`, `cat`, `grep -r` and Node `fs` on them. A recursive search was slow. The measurements separated three costs:

| Cost | Size, 0.4.8 | Where the fix is |
|---|---|---|
| Store latency: one request for each file, one at a time | The latency of the store, for each file | In the host driver (parallel read-ahead and a content cache). Not in this repository. |
| Host callbacks: about 55 for each file on a `js_bridge` mount | 0.6 ms per file on macOS, 4.4 ms in a Linux container | Commit 1 |
| The sidecar itself: a WASM command is slow for each file on any filesystem | 2.4 ms per file on macOS, 4.3 ms in a Linux container | Commits 2 to 6 |

Things that did not help, so nobody has to try them again:

- Other mount types. `host_dir` on a local directory and the VM's own disk have the same cost per file as a `js_bridge` mount with contents in memory.
- Other guest programs. `rg` from the software registry is about 20% faster than `grep`, not more.
- A `host_dir` mount on a gcsfuse directory. It was slower than the `js_bridge` mount.

## 5. How the cause was found

### Host callbacks on a `js_bridge` mount

A counting driver (`bench/lab.ts`) records each callback. One `cat` of one file made 68 callbacks. Most were `stat` and `realpath` of the same path and of each parent directory, repeated for each guest syscall. A comment in `crates/native-sidecar/src/plugins/js_bridge.rs` explains the source: the kernel permission wrapper resolves the subject of each operation through `realpath` first.

For 500 files, `grep -rl` made these callbacks: `stat` 8018, `realpath` 11957, `lstat` 5503, `exists` 1004, `pread` 950, `readDir` 5.

### The sidecar itself

A profile with `sample` (8 s, `grep -rl` over 500 files in a loop, release build with debug symbols) showed:

- The grep worker thread waited in `sync_call_response_with_max_response_bytes` for 92% of its active time.
- The sidecar main thread was busy in 73% of the samples.

So the guest was not the limit. The cost was the number of sync requests multiplied by the service time of the one dispatcher thread.

Sync requests for one `grep -rl needle n500 | wc -l`:

| Request | Count | Per file |
|---|---|---|
| `process.fd_stat` | 2915 | 5.8 |
| `process.fd_filestat` | 2525 | 5.0 |
| `process.fd_read` | 950 | 1.9 |
| `fs.statSync`, `fd_close`, `path_open_at`, `fd_chdir_path` | about 510 each | 1 each |
| `process.take_signal` (from the shell) | 4685 | 9.4 |
| `child_process.poll` (from the shell) | about 12,700 | 25 |

### Four causes

Line numbers are for commit `e57c6aa3b`.

1. **Repeated path resolution in the overlay root.**
   - Each overlay operation calls `touches_internal_metadata` (`crates/vfs/src/posix/overlay_fs.rs:312`), which resolves the full path two times through `resolve_merged_path` (`:135`).
   - Each path component calls `merged_lstat` (`:819`), which builds a base64 whiteout marker path (`:288`) and makes several `MemoryFileSystem` lookups.
   - `MemoryFileSystem::resolve_path_with_options` (`crates/vfs/src/posix/vfs.rs:945`) normalizes the path two times and makes one `format!` for each component.
   - `MountTable::resolve_content_index` (`crates/vfs/src/posix/mount_table.rs:1794`) adds one `realpath` before each `stat` and `pread`.
   - Baseline samples on the main thread: `resolve_path_with_options` 1382, `merged_lstat` 1189, `normalize_path` 1048, of 4152 busy samples.

2. **A child request waits for the next poll of its parent.**
   - The supervisor puts each ordinary request of a child of a WASM parent back in the queue (`crates/native-sidecar/src/execution/child_process.rs:9271`). It claims a child with an empty queue only if the child is JavaScript (`:2848`).
   - So only the `child_process.poll` of the shell services a grep request, and that poll does not park (`:7407`).
   - The shell calls `waitpid(WNOHANG)` in a loop (`crates/execution/assets/runners/wasm-runner.mjs:7446`). Each loop sends 3 polls and 1 `take_signal`.
   - Each grep syscall thus costs about three round trips. A test with a 1 ms sleep in the shell loop gave 15.7 ms per file, which proves the dependency.

3. **A deep copy of the mount list for each request.** `build_javascript_socket_path_context` (`crates/native-sidecar/src/execution/network/tcp.rs:1948`, copy at `:1986`) clones `vm.configuration.mounts` for every sync request. After the fix of cause 1, the build and drop of this struct were about 1150 of 3100 busy samples.

4. **`getenv` for debug switches on each request.** See `crates/execution/src/javascript.rs:188`, `crates/native-sidecar/src/execution/process_events.rs:522`, and `crates/v8-runtime/src/host_call.rs:25` and `:66`.

### What upstream already has

The branch `rc/perf-batch` contains commit `389756c6a`, which rewrites the overlay and removes cause 1. That explains why the published 0.4.9-rc.1 gives 1.53 ms per file for `grep` on the VM disk: the same as 0.4.8 plus only the fix for cause 1 (1.49 ms). The release candidate does not fix causes 2, 3 and 4, and it does not reduce the callbacks of a `js_bridge` mount (3.07 ms per file there, unchanged).

## 6. The commits

Each commit compiles alone (`cargo check --release -p agentos-native-sidecar`).

### 1. `perf(js-bridge)`: attribute cache

File: `crates/native-sidecar/src/plugins/js_bridge.rs`.

- A cache for each mount holds the answers of `stat`, `lstat` and `realpath`, and the `ENOENT` errors of those calls.
- `exists` uses a cached `stat` answer when one is present, and records a negative answer.
- Any mutation through the mount (`writeFile`, `pwrite`, `mkdir`, `createDir`, `removeFile`, `removeDir`, `rename`, `symlink`, `link`, `chmod`, `chown`, `utimes`, `truncate`) clears the cache of that mount.
- The cache has a limit of 65,536 entries. At the limit it is cleared.
- Off by default. `AGENTOS_JS_BRIDGE_ATTR_CACHE_MS` sets the lifetime.

Effect: 55 callbacks per file become about 7. The remaining ones are one `lstat` for each directory entry (the TypeScript client makes those in its `readDir` handler, without a round trip from the sidecar), plus one `realpath`, one `stat` and the `pread` calls.

The trade: a change that the host makes behind the mount is invisible until the lifetime ends. Measured with a lifetime of 2 s: a file that the host creates after the guest looked for it stays `ENOENT` for the guest until 2 s pass.

### 2. `perf(vfs)`: overlay path cache and cheaper path resolution

Files: `crates/vfs/src/posix/vfs.rs`, `crates/vfs/src/posix/overlay_fs.rs`.

- `normalize_path` returns early for a path that is already normal.
- `resolve_path_with_options` uses one buffer.
- A `PathIndex` wrapper takes a new process-wide generation on each mutable access to the path map.
- A cache holds the results of `touches_internal_metadata` and `is_whited_out`. Any create, remove, rename, link or symlink in a layer changes the generation and discards the cache. The cache has a limit of 4096 entries and 256-byte paths.

This fixes cause 1. It is only for a 0.4.8 base; see section 9.

### 3. `perf(sidecar)`: the supervisor services WASM children

File: `crates/native-sidecar/src/execution/child_process.rs`.

The supervisor now services ordinary sync requests of WebAssembly children of a WebAssembly parent. Stream and exit events stay with the parent. This fixes cause 2 and is the largest gain that `rc/perf-batch` does not have.

This commit changes which part of the sidecar services a request. The reason for the original requeue gate is not known. A maintainer must confirm the design.

### 4. `perf(sidecar)`: shared mount list

Files: `state.rs`, `vm.rs`, `execution/network/tcp.rs`, `service.rs` in `crates/native-sidecar/src`.

`VmConfiguration.mounts` is an `Arc<Vec<MountDescriptor>>`. No behaviour change. This fixes cause 3.

### 5. `perf`: debug switches read one time

Files: `crates/execution/src/javascript.rs`, `crates/native-sidecar/src/execution/process_events.rs`, `crates/v8-runtime/src/host_call.rs`.

Four debug switches use a `OnceLock`. No behaviour change, except that a change of these variables after start has no effect. This fixes cause 4.

### 6. `perf(wasm)`: opt-in idle park

Files: `crates/execution/assets/runners/wasm-runner.mjs`, `crates/execution/src/wasm.rs`.

With `AGENTOS_WASM_IDLE_CHILD_PARK=1`, a WASM parent that only waits for children sleeps 0.25 to 1 ms between poll sweeps, after four sweeps without progress.

The trade: an event that only the parent can pull can wait up to 1 ms. Such events are relayed stdout or stderr, an exit, or a request of a child that the supervisor does not service, such as a Python child. Python children were not tested, so the switch is off by default.

## 7. Results

All times are in ms. N is the number of files of about 40 bytes in one directory.

### macOS arm64, VM disk, commits 2 to 6

Three interleaved rounds, median. The rounds differed by 3% or less at N=200 and N=500, and by up to 25% at N=4.

| Program | Baseline N=4 / 200 / 500 | ms per file | Patched N=4 / 200 / 500 | ms per file | Patched + park, ms per file |
|---|---|---|---|---|---|
| `true` | 80 / 74 / 81 | – | 74 / 73 / 76 | – | – |
| `ls -la` | 169 / 489 / 1038 | 1.75 | 162 / 248 / 385 | 0.46 | 0.38 |
| `find -type f` | 158 / 232 / 399 | 0.49 | 157 / 183 / 235 | 0.16 | 0.14 |
| `grep -rl` | 166 / 624 / 1380 | 2.44 | 146 / 288 / 494 | 0.70 | 0.55 |
| `cat * \| grep -c` | 179 / 832 / 1899 | 3.47 | 163 / 357 / 678 | 1.05 | 0.90 |
| Node script with `fs` | 129 / 261 / 458 | 0.66 | 103 / 149 / 182 | 0.15 | 0.09 |

Effect of each stage on `grep`, ms per file, single runs: baseline 2.44; commit 2 only 1.49; plus commit 3 and the park 0.84; plus commits 4 and 5, 0.54 with the park and 0.70 without.

### macOS arm64, `js_bridge` mount, all six commits, cache lifetime 2 s

| Program | Published N=4 / 200 / 500 | ms per file | All commits N=4 / 200 / 500 | ms per file | Callbacks per file |
|---|---|---|---|---|---|
| `ls -la` | 186 / 652 / 1405 | 2.46 | 155 / 231 / 356 | 0.41 | 55 → 5 |
| `find -type f` | 167 / 262 / 476 | 0.62 | 157 / 185 / 233 | 0.15 | 15 → 5 |
| `grep -rl` | 175 / 745 / 1663 | 3.00 | 154 / 288 / 503 | 0.70 | 55 → 7 |
| `cat * \| grep -c` | 186 / 1064 / 2448 | 4.56 | 159 / 367 / 710 | 1.11 | 83 → 9 |
| Node script with `fs` | 134 / 296 / 561 | 0.86 | 126 / 131 / 217 | 0.18 | 23 → 4 |

### Linux arm64 container (Docker Desktop)

The noise is about 10%. No combined binary was built for Linux; the two groups of commits were measured separately.

Commits 2 to 6, VM disk, N=500, two rounds, ms per file in parentheses:

| Program | Baseline | Patched | Patched + park |
|---|---|---|---|
| `ls -la` | 1328, 1287 (2.19) | 659, 612 (0.88) | 639, 605 (0.84) |
| `find -type f` | 636, 565 (0.78) | 378, 329 (0.34) | 364, 344 (0.31) |
| `grep -rl` | 2314, 2374 (4.3) | 1039, 957 (1.6) | 1044, 933 (1.6) |
| `cat * \| grep -c` | 3098, 2829 (5.5) | 1416, 1429 (2.4) | 1173, 1228 (2.0) |
| Node script with `fs` | 698, 530 (0.9) | 246, 246 (0.11) | 252, 231 (0.17) |

Commit 1 only, `js_bridge` mount, ms per file:

| Program | Cache off | Cache on (2 s) |
|---|---|---|
| `ls -la` | 6.34 | 1.84 |
| `find -type f` | 1.52 | 0.79 |
| `grep -rl` | 8.69 | 4.29 |
| `cat * \| grep -c` | 11.79 | 4.61 |
| Node script with `fs` | 2.38 | 0.53 |

### A large folder on a `js_bridge` mount, macOS

5000 files in 10 directories: 4000 text files of 20 KB and 1000 binary files of 2 MB, 2.03 GB in total, contents in memory (`bench/h8-large-folder.ts`).

| Command | Published | Commit 1 only | All commits |
|---|---|---|---|
| `find` over all files | 3.6 s | 2.1 s | 1.1 s |
| `grep -rl --include='*.md'` over all | 16.3 s | 8.1 s | 3.9 s |
| `grep -rl` over all 5000 files | 37.8 s | 25.4 s | 15.6 s |
| Node `fs` loop over the text files, retained JS context | 5.0 s | 2.2 s | 1.6 s |

## 8. Correctness and tests

### Guest checks

`bench/floor-check.ts` runs 59 guest commands and writes the results to a file. The results of the baseline, of commits 2 to 6, and of commits 2 to 6 with the park are identical on macOS and on Linux. The only raw difference is a random shadow directory name in an error text. The checks cover:

- `ls -la`, `cat`, `grep -r`, `find`, `stat`, Node `fs`;
- write then read, rename, delete, a file replaced by a directory, host API write, move and remove seen by the guest;
- symlinks (retarget, dangling, loop, relative, absolute directory) and hard links;
- delete of a lower-layer file, and the hidden `/.agentos-overlay` namespace through symlinks;
- permissions (`EACCES` on a file and a directory with mode 000);
- a 360-character path;
- pipes, exit codes, SIGPIPE, `$(...)`, here-doc, background and `wait`, `kill`, nested `sh`, and Node `execSync` of WASM commands.

`bench/h6-attr-cache-check.ts` checks commit 1 on a `js_bridge` mount: reads, a missing file, refused writes on a read-only mount, and the stale window. It passes on macOS and on Linux, and also with all six commits together on macOS.

### Rust tests (`cargo test --release --no-fail-fast`, macOS, commits 2 to 6)

| Crate and targets | Patched | Baseline |
|---|---|---|
| `agentos-vfs-core` | 116 pass, 0 fail, 15 ignored | not run |
| `agentos-kernel` | all pass | not run |
| `agentos-v8-runtime --lib` | 153 pass | not run |
| `agentos-vfs` (not changed) | 3 failures in `tests/s3.rs` | not run |
| `agentos-native-sidecar` (`--lib` plus 13 integration targets) | 876 pass, 104 fail | 876 pass, 104 fail, the same names |
| `agentos-execution` (`wasm`, `smoke`, `process`, `wasm_nonblocking_stdin`) | 3 suites fail | the same 3 fail, the same messages |

### Limits of this evidence

- The full test builds of `agentos-native-sidecar` and of `agentos-execution --lib` do not compile on macOS (`posix_fadvise`, `pipe2`), with or without the patches. Only selected targets ran.
- The `wasm_shell_*` tests are in the set that fails on macOS before the patches. So the Rust suite does not test commit 3 on that machine. The evidence for commit 3 is the 59 guest checks.
- Nobody ran the Rust tests on Linux. **This is the first thing to do.**
- No Rust test covers commit 1. The test suite was not run against commit 1.
- Python children of a WASM parent were not tested. The test VM had no Python.

## 9. Plan for upstream pull requests

Rivet's `main` moved after 0.4.8. Each pull request needs a rebase onto `main` (or onto `rc/perf-batch`, if that branch merges first).

| Commit | Fit | What it still needs |
|---|---|---|
| 4. Shared mount list | Good. Small, no behaviour change. | Rebase. It still applied to `rc/perf-batch` when checked. |
| 5. Debug switches read one time | Good. Small. | Rebase. Can go in the same pull request as commit 4. |
| 1. Attribute cache for `js_bridge` | Good as a feature, with changes. | A mount option in place of the environment variable (this needs a field in `JsBridgeMountConfig` and in the TypeScript mount config). Tests for hits, the lifetime, and the clear on mutation. A decision on whether a `readDir` answer can fill the cache. |
| 3. Supervisor services WASM children | The largest gain that upstream does not have, but a design change. | A maintainer must explain or remove the reason for the requeue gate. A run of the `wasm_shell_*` and child-process tests on Linux with the WASM fixtures. Probably the same rule for Python children. Open an issue with the profile first. |
| 6. Idle park | Not as it is. | The correct fix is a `child_process.poll` that waits in the sidecar for a child event, or a shell that blocks in `waitpid`. Use this commit only as evidence. |
| 2. Overlay path cache | Not for upstream. | `389756c6a` on `rc/perf-batch` replaces it. Keep it only for a fork on 0.4.8. |

A good order: commits 4 and 5 first (easy to accept), then the attribute cache, then an issue for commit 3 with the numbers from section 5.

## 10. What remains

- **The 80 ms for each `exec`.** In a `true` loop, `sha256::compress256` was 1599 of 1957 main-thread samples, about 16 ms for each exec. `snapshot_cache_key` (`crates/v8-runtime/src/snapshot.rs:746`) hashes the whole bridge source on each call of `try_get_with_userland` (`:650`). The release candidate already reduces this cost (`true` takes 45 ms there).
- **17 sync requests per file for `grep`,** of which about 11 are `fd_stat` and `fd_filestat`. This is in the WASM libc and runner layer.
- **Round-trip cost.** Each request is about 40 µs on macOS, mostly two thread wake-ups. A Linux container is slower.
- **The shell loop** still sends poll and `take_signal` requests without a pause unless the park is on.
- **A combined Linux binary** with all six commits was not built or measured.

## 11. Other defects found on 0.4.8

These are not fixed here. Each one is a candidate for an upstream issue.

| Defect | How to see it |
|---|---|
| The output of `console.log` in guest Node is lost when stdout is a pipe or a file. | `node -e "console.log(1)" \| wc -l` gives 0. `fs.writeSync(1, ...)` works. |
| `exec` of a host function command in a shell script exits with 127. | A script with `exec agentos-<collection> <function> ...`. Without `exec` it works. |
| Many parallel `fs.promises.readFile` calls fail with `ENFILE`. | 500 parallel reads in one JS context reach the limit of 256 descriptors. |
| A directory above the listing limit gives a confusing error. | With more than 4096 entries (`limits.resources.maxReaddirEntries`), `ls`, `find` and `grep -r` report `Bad address (os error 21)`. Node reports the real reason: `ENOMEM: directory listing with 5000 entries exceeds configured limit 4096`. |
| A pipe is slow for large data. | `cat` of a 2 MB file into `wc -c` takes about 0.8 s. |
| The `chmod` program fails with `ENOENT` on a shadow path. | Seen in `floor-check.ts`, before and after the patches. |
| `object_s3` (a mount for plain S3 objects) is compiled but not registered. | See the comment in `crates/native-sidecar/src/plugins/mod.rs`. |

## 12. The benchmark scripts

All scripts are in `perf-notes/bench/` and run with Bun. They use the published `@rivet-dev/agentos-core` 0.4.8 client.

| Script | Purpose |
|---|---|
| `lab.ts` | Shared parts: an in-memory `js_bridge` driver that counts and traces each callback, and a timer. |
| `h1-floor.ts` | The main benchmark. Cost per file for each guest program, on the VM disk and on the `js_bridge` mount. `SIZES` sets the file counts, `BYTES` the file size, `OPS=1` prints the callback counts. Ignore the `runJs context` lines at the end; that part of the script is broken. |
| `h1b-context.ts` | The same `fs` loop in a retained JS context, and a trace of the callbacks for one `cat`, one `grep` and one `head`. |
| `h2-programs.ts` | `rg` and `fd` from the software registry, and a `host_dir` mount, against the same files. It downloads two packages from the registry. |
| `h3-cold.ts` | Store latency (`LATENCY`, default 30 ms) with read-ahead strategies in the driver. |
| `h6-attr-cache-check.ts` | Correctness of commit 1, with the stale window. |
| `h7-large-dir.ts` | One directory with 1000 to 5000 entries. Shows the listing limit. |
| `h8-large-folder.ts` | 5000 files with large binary files. `FULL=1` adds the two searches over all files. `PDF_MB` sets the size of the binary files. |
| `floor-check.ts` | The 59 guest checks. Run it with two binaries (`OUT=<file>`) and compare the files. |
| `floor-loop.ts`, `floor-once.ts`, `floor-trace.ts` | Small helpers for profiling: a loop to sample, one run, and a request trace. The header of each file gives the command. |

To profile on macOS: build with `CARGO_PROFILE_RELEASE_DEBUG=1`, run `floor-loop.ts`, find the child process `agentos-native-sidecar` of the Bun process, and run `sample <pid> 8`. To capture the stderr of the sidecar, set `AGENTOS_SIDECAR_BIN` to a small shell script that runs the binary with `exec` and `2>>file`, and set `RUST_LOG=debug`.
