# Tools

<!-- Written by tools/checks/check-catalog.mjs --write from tools/catalog.json: edit those. -->

Every tool by the question it answers. The folder a tool is in is its category; the catalog,
[`catalog.json`](catalog.json), says what each answers, how it is run, its tests and, for an
instrument, a real output from this repository's own data and how to read it.
check:boundaries fails a tool the catalog does not know. When a run is slow, flickers or
stops, [`live/DIAGNOSING.md`](live/DIAGNOSING.md) is the order to look in; the flags of the
runners are in [`run/README.md`](run/README.md), the live switches in
[`live/README.md`](live/README.md).

| folder | what is in it |
|---|---|
| `run/` | start a program and get a report: in a browser, in Node, from a phone |
| `live/` | attach to a game a person is playing |
| `read/` | read what a run left behind: a trace, a capture, shaders, a recording |
| `translator/` | cork's work on a real program: its mix, its code, its calls, its cost |
| `bundles/` | make, inspect and audit bottles, archives and installers |
| `gates/` | two paths of the engine compared on a real GPU (npm run cdp:*) |
| `checks/` | the rules of the code check:boundaries holds (and one run by hand) |
| `generators/` | scripts that rewrite a committed file from a specification or a processor |
| `ci/` | the repository's own jobs in its workflows |
| `lib/` | modules the tools share, never run alone |
| `fixtures/` | programs and helpers the packages' tests import |
| `docs/` | the documentation site and its link check |

## Questions

### Does a title run in a browser, and what did the run do?

[`run/game.mjs`](run/game.mjs): `npm run cdp:game -- <bundle-id> [flags]  (flags: tools/run/README.md)`

```
The Swapper undefined -- TheSwapper.exe
  ran for 13ms, 4 guest instructions
stopped: exited with 3221225477
errors -- what the engine did not do:
  mscoree.dll!_CorExeMain: not implemented, answered with nothing
1 imports nothing claimed:
  mscoree.dll  (1)
```

From `tools/cdp_test/reports/game-2026-11-14T03-28-29-645Z.txt (a run of steam-231160 without its .NET runtime; it printed "undefined" for the missing version, which the title line now leaves out)`. The first lines are how the run ended (exit 0xC0000005 here); "errors" and "imports nothing claimed" are what the engine lacked, the first thing to implement. The rest of a report is the address space, the last host calls and, with flags, profiles and frames.

### What does a frame cost once a title is up, and where does the time go?

[`run/frames.mjs`](run/frames.mjs): `npm run cdp:frames -- <bundle-id> [--seconds 60] [--settle 20]`

Needs the shared browser, a GPU or a phone: no sample yet from this
machine's data. Run `npm run cdp:frames -- <bundle-id> [--seconds 60] [--settle 20]` and put what it prints here.

### Did a title get worse: does it still reach its game, and do its frames come as evenly as before?

[`run/smoke.mjs`](run/smoke.mjs): `node tools/run/smoke.mjs <bundle-id> [--runs 3] [--against FILE]; on runs already made: smoke.mjs span <presents.json> | drops <frames.json>...`

Needs the shared browser, a GPU or a phone: no sample yet from this
machine's data. Run `node tools/run/smoke.mjs <bundle-id> [--runs 3] [--against FILE]; on runs already made: smoke.mjs span <presents.json> | drops <frames.json>...` and put what it prints here.

### What does the launcher's own page cost while a title runs?

[`run/launcher.mjs`](run/launcher.mjs): `node tools/run/launcher.mjs <bundle-id> (launcher running: npm run ui)`

Needs the shared browser, a GPU or a phone: no sample yet from this
machine's data. Run `node tools/run/launcher.mjs <bundle-id> (launcher running: npm run ui)` and put what it prints here.

### Does the launcher lay out on a phone, a tablet and a desktop?

[`run/ui-layout.mjs`](run/ui-layout.mjs): `node tools/run/ui-layout.mjs [card regex] (launcher running)`

Needs the shared browser, a GPU or a phone: no sample yet from this
machine's data. Run `node tools/run/ui-layout.mjs [card regex] (launcher running)` and put what it prints here.

### Where does an installer, or an installed program, stop in Node, and what is each process waiting on?

[`run/install-watch.mjs`](run/install-watch.mjs): `node tools/run/install-watch.mjs <setup.exe | disc.iso | archive.zip> | --bundle ID [--which PATH] [--args ARGS]`

```
0.8 OUT stateblock.c:416: Running initial read state tests
0.8 divergence {"api":"Direct3D 8","detail":"GetLightEnable(0x0, 0x81ff948) answered D3DERR_INVALIDCALL"}
0.8 divergence {"api":"Direct3D 8","detail":"GetLight(0x0, 0x81ff8e0) answered D3DERR_INVALIDCALL"}
1.0 OUT stateblock.c:1155: Test failed: Chain stage 0, render state 0x9b: expected 0, got 0x3f800000.
1.6 OUT 16b0:stateblock: 9283 tests executed (0 marked as todo, 0 as flaky, 1 failure), 0 skipped.
1.6 exit {"code":1}
run -> 1
```

From `node tools/run/install-watch.mjs --bundle wine-d3d8 --args stateblock --every 5 --minutes 1`. Each line is seconds since the start and what happened: OUT is what the program printed, divergence a call answered otherwise than Windows would, then how each process ended. Here Wine's stateblock test ran 9283 checks and one failed (render state 0x9b read back 1.0, expected 0).

### Play a bottle from this checkout, with nothing else set up

[`run/play.mjs`](run/play.mjs): `node tools/run/play.mjs <bundle-id> (then open the page it prints)`

Needs the shared browser, a GPU or a phone: no sample yet from this
machine's data. Run `node tools/run/play.mjs <bundle-id> (then open the page it prints)` and put what it prints here.

### Do Wine's conformance tests pass in the engine?

[`run/wine-tests.mjs`](run/wine-tests.mjs): `npm run wine-tests -- <dll>[:<test>]... [--browser] [--baseline FILE]`

```
winetest build 4e819f054dd2d9ee855ee3f1e30d8c1bb8f80fcf, 2 at a time, 120 s each
  kernel32:sync                pass            executed 355430 failures     0   11.7 s
```

From `node tools/run/wine-tests.mjs kernel32:sync`. One row a test: how it ended, the checks it executed and those that failed, and its time; report.md beside it groups the failing lines and, with --baseline, says what got worse.

### Where do the Visual C++ runtimes' own load checks let a program run, against Windows?

[`run/vcredist-matrix.mjs`](run/vcredist-matrix.mjs): `node tools/run/vcredist-matrix.mjs [--fetch] [--out DIR]`

```
ok   vc80-crt: external program.manifest; the runtime and its manifest beside the program -- Windows runs, engine runs
ok   vc80-crt: LoadLibrary, embedded manifest; the runtime and its manifest beside it -- Windows runs, engine runs
ok   vc80-crt: the runtime installed: only in system32, the store presents it -- Windows runs (as with the redistribut
ok   vc80-crt: no manifest at all; the runtime beside the program -- Windows R6034, engine runs
ok   vc80-crt: LoadLibrary, no manifest at all; the runtime beside the program -- Windows R6034, engine runs
```

From `node tools/run/vcredist-matrix.mjs --fetch (21 rows, 0 DIFF)`. A row a runtime and a deployment layout: what Windows does and what the engine did; DIFF marks a row where they part, "by decision" one the engine answers itself on purpose.

### What does a phone's browser keep, and which wasm tail call takes its page down?

[`run/webkit-probe/tail-calls.html`](run/webkit-probe/tail-calls.html): `open tools/run/webkit-probe/tail-calls.html or storage.html from the launcher on the phone`

Needs the shared browser, a GPU or a phone: no sample yet from this
machine's data. Run `open tools/run/webkit-probe/tail-calls.html or storage.html from the launcher on the phone` and put what it prints here.

### What is a game a person plays doing right now: console, phases, profile, memory, picture, sound?

[`live/live.mjs`](live/live.mjs): `node tools/live/live.mjs help | <command> [args]`

```
21757 ms sampled: idle   6.1%, garbage collection   2.9%
self:
   35.0%  sleep engine.worker.js:12892
   13.6%  waitWhile engine.worker.js:12882
    8.1%  showNow engine.worker.js:450658
inclusive:
  100.0%  (root) :0
   67.8%  run engine.worker.js:837745
^showNow : 2004 of 21757 ms (9.2%)
    9.2%  show engine.worker.js:450858  <  presentTo engine.worker.js:835602  <  present engine.worker.js:82812
```

From `live.mjs profile --file dbg/leak/start-profile/w10-engine.cpuprofile, then --callers "^showNow "`. Attached commands need the shared browser; profile --file and diff read files. Self time is the function itself, inclusive with what it called; a stretch is time outside translated code (led by sleep or waitWhile it is the thread parked, not working). --callers says who reached a function, by the time under it: showNow is 9.2 % of this engine worker, all through present.

### Where did a person's DevTools trace go, by thread and function?

[`read/trace-summary.mjs`](read/trace-summary.mjs): `node tools/read/trace-summary.mjs <Trace-*.json.gz> (a trace the person saved)`

Needs the shared browser, a GPU or a phone: no sample yet from this
machine's data. Run `node tools/read/trace-summary.mjs <Trace-*.json.gz> (a trace the person saved)` and put what it prints here.

### What do a title's real frames cost the graphics worker, played again in Node?

[`read/graphics-replay.mjs`](read/graphics-replay.mjs): `node tools/read/graphics-replay.mjs <capture> (from game.mjs --graphics-capture FILE)`

Needs the shared browser, a GPU or a phone: no sample yet from this
machine's data. Run `node tools/read/graphics-replay.mjs <capture> (from game.mjs --graphics-capture FILE)` and put what it prints here.

### Does our HLSL compiler agree with Microsoft's on a title's own shaders?

[`read/shader-diff.mjs`](read/shader-diff.mjs): `node tools/read/shader-diff.mjs <game-*-shaders dir> (from a game.mjs run; Windows for D3DCompiler)`

Needs the shared browser, a GPU or a phone: no sample yet from this
machine's data. Run `node tools/read/shader-diff.mjs <game-*-shaders dir> (from a game.mjs run; Windows for D3DCompiler)` and put what it prints here.

### Where are the gaps, clicks and repeats in what the person heard?

[`read/wav-scan.mjs`](read/wav-scan.mjs): `node tools/read/wav-scan.mjs <file.wav> (from live.mjs audio save)`

Needs the shared browser, a GPU or a phone: no sample yet from this
machine's data. Run `node tools/read/wav-scan.mjs <file.wav> (from live.mjs audio save)` and put what it prints here.

### What does a run in Node cost the translator, and where did the program stop?

[`translator/launch-probe.mjs`](translator/launch-probe.mjs): `node tools/translator/launch-probe.mjs <bundle-id> [--turns N] [--series S] [--translation-store DIR] [--cork-out FILE]`

```
mode: default, 1 executor(s), cork {}; node 26.13.1, V8 14.6.202.34-node.40, branch hints read
Wine d3d8 tests -- d3d8_test.exe
  entry image: 745472 bytes
every import bound.
  [guest 2] 1008:visual: 141799 tests executed (0 marked as todo, 0 as flaky, 3168 failures), 15 skipped.
stopped: exited with 255
```

From `node tools/translator/launch-probe.mjs wine-d3d8 --turns 20000`. The head is the mode and what was bound; then what the program printed, and "stopped:" how the run ended, followed by the calls it made last and, with --series or --cork-out, the translator's figures. Here Wine's d3d8 visual test ran in Node, where nothing is drawn, so its read-backs fail by design.

### Which guest instructions does a run execute most, what does each kind cost, and how do its calls go?

[`translator/cork-mix.mjs`](translator/cork-mix.mjs): `node tools/translator/cork-mix.mjs <blocks.json> [--file DLL@BASE]... [--calls]`

```
114795 blocks, 5435328071 instructions in TheSwapper.exe, clr.dll@0x2dea000, 1082654156 block executions outside them
share  ops-share  ops/insn  form
  9.6%      14.1%        48  push r32
  3.3%       9.7%        95  mov m32,r32
  4.0%       7.2%        59  call rel
  4.8%       7.0%        48  jne rel
```

From `cork-mix.mjs dbg/leak/swapper-ngen-load-blocks.json --file clr.dll@0x2dea000`. share is of the executed instructions, ops-share of the wasm operations they cost, ops/insn what one form costs: a form whose ops-share is far above its share (push stack32, 147 ops) is where the translator spends. --calls prints the calls' shape as JSON (direct, indirect, import; registers live around them).

### What machine code, wasm text or wasm bytes does a region become, weighed by how often it ran?

[`translator/cork-asm.mjs`](translator/cork-asm.mjs): `node tools/translator/cork-asm.mjs --image DLL@BASE | --bin FILE --at A --entry A [--blocks FILE] [--classes|--wat|--expansion]`

```
     entry  blocks  x86  wasm B  machine  bytes  per x86  ran x86  weighted
0x00401160      43  229   11492     3297  15122    14.40       9M      2.94
ran: 0.01 G guest instructions in these blocks, 2.940 machine instructions an executed one
by kind, an executed guest instruction: other 0.935 (31.8%), branch 0.606 (20.6%), memory 0.444 (15.1%), compare 0.395
```

From `cork-asm.mjs --bin modules/cork/bench/micro/images/crc-x87.bin --at 0x401000 --entry 0x401160 --blocks crc-x87.blocks.json --classes`. "per x86" is machine instructions a guest instruction becomes in the code as compiled; "weighted" the same over what ran. The kinds line says where the instructions go besides the guest's own work (branch, memory, frame spills). The host here is arm64 (this VM).

### Which function of a system or runtime DLL is hot?

[`translator/pdb-hot.mjs`](translator/pdb-hot.mjs): `node tools/translator/pdb-hot.mjs <blocks.json> <image.dll> <image.pdb> <base-hex> [top]`

```
48991 public symbols; the image 55.6% of 2436222218 block executions
  2.11%  ?mark_object_simple1@gc_heap@WKS@@KGXPAE@Z
  1.68%  ?relocate_address@gc_heap@WKS@@KGXPAPAE@Z
  1.43%  ?relocate_survivors_in_plug@gc_heap@WKS@@KGXPAE0PAUrelocate_args@12@@Z
  1.41%  ?FillEntryDataForAncestor@MethodDataObject@MethodTable@@IAEXPAV2@@Z
```

From `pdb-hot.mjs dbg/leak/swapper-ngen-load-blocks.json clr.dll dbg/sym/clr.pdb 2dea000`. The image's share of the run's block executions, then its public functions by share: here the CLR's garbage collector (mark, relocate) leads The Swapper's ngen load.

### What is the code at module+offset, as a profile names it?

[`translator/disasm.mjs`](translator/disasm.mjs): `node tools/translator/disasm.mjs <bundle-id | bundle.btl> <module> <offset[:count]> (Python with capstone)`

```
== clr.dll+0xb5a08
  000b5a08  8d65f4               lea      esp, [ebp - 0xc]
  000b5a0b  5f                   pop      edi
  000b5a0c  5e                   pop      esi
  000b5a0d  8b4dfc               mov      ecx, dword ptr [ebp - 4]
  000b5a10  33cd                 xor      ecx, ebp
```

From `disasm.mjs steam-231160-net clr.dll b5a08:8`. Offset in the module, bytes, instruction: the hottest clr.dll address of the ngen load is a function's epilogue (its security cookie check, then ret 4).

### What does one call into the host, or one maths operation, cost?

[`translator/host-call-bench.mjs`](translator/host-call-bench.mjs): `node tools/translator/host-call-bench.mjs [N] --call SPEC... | --math [--rows RE]`

```
N 2000000, 3 rounds; ns a call is the median over the rounds; node 26.13.1, V8 14.6.202.34-node.40, branch hints read
                                this ns/call      min..max  host calls
KERNEL32.dll!lstrlenA(s:a)                24         2..27           1
KERNEL32.dll!GetACP()                    204      190..214     2000001
```

From `host-call-bench.mjs 2000000 --rounds 3 --call 'KERNEL32.dll!lstrlenA(s:a)' --call 'KERNEL32.dll!GetACP()'`. ns a call over the loop without it, the spread of the rounds, and the host calls the bridge counted: lstrlenA is guest code (1 host call, the exit), GetACP crosses every time, about 200 ns. A spread wider than the median is noise: raise N.

### Where do several executors beat one?

[`translator/executor-sweep.mjs`](translator/executor-sweep.mjs): `node tools/translator/executor-sweep.mjs [--threads 1,2,3] [--executors 1,2,3,4] [--reps 3]`

```
T=2 K=- H=- E=1  best3 1.55s [1.26 1.83 1.56]  x1.00 vs E=1  1807 MIPS (2.80 G)  elsewhere 0% 0 calls
T=2 K=- H=- E=2  best3 1.01s [0.96 1.32 0.77]  x1.53 vs E=1  2762 MIPS (2.80 G)  elsewhere 53% 2 calls
best of several executors: T=2 K=- H=- E=2  x1.53
```

From `executor-sweep.mjs --threads 2 --executors 1,2 --host 0 --sync 0 --reps 3`. A row a point: the mean of its three fastest runs [each run], the ratio to one executor, MIPS, and the share run elsewhere. Here two threads ran 1.53 times as fast on two executors. Runs of one point that differ threefold (an earlier run of this sweep on the loaded machine gave 7.23 against 0.78 s) are the machine, not the engine: rerun on a quiet one.

### What does a title import, or look up by name, that this build does not export?

[`bundles/import-audit.mjs`](bundles/import-audit.mjs): `node tools/bundles/import-audit.mjs <file|dir|bundle.btl|disc.iso>... [--dynamic --specs DIR]`

```
15 images read
PACKED? bundle.btl:Futuremark\3DMark03\fmod.dll: its imports are looked up at run time
NAMED, NO LIBRARY mscoree.dll  <- EasyFMSI.exe, FMSI.dll, FMSIX.dll, atimgpud.dll, cpuidsdk.dll, SI3.dll, msvcr71.dll,
NAMED, NO LIBRARY atiadlxy.dll  <- FMSI.dll
MISSING BY NAME kernel32.dll (20)
  __C_specific_handler  <- cpuidsdk.dll
  OpenProcessToken  <- mfc70.dll
```

From `import-audit.mjs bundles/3dmark03/bundle.btl --dynamic --specs dbg/wine-specs`. PACKED is an image whose imports are found at run time (run it to know); NAMED, NO LIBRARY a DLL its strings name that nothing provides; MISSING BY NAME a function a program may GetProcAddress that this build does not export, with who names it.

### Pack, verify, list, size, prune or extract a bottle, or unpack a zip of any size

[`bundles/make-btl.mjs`](bundles/make-btl.mjs): `node tools/bundles/make-btl.mjs pack|verify|list|translations|extract|tree|prune|zip ...`

```
   463.5 MiB   284  Futuremark\3DMark03
     2.2 MiB     7  Common Files\Futuremark Shared
     0.0 MiB     1  .bottlify\registry.json
   465.7 MiB   292  total
   0.01 GiB       1 files  3dmark11-setup.exe
   0.20 GiB       1 files  cab1.cab
```

From `make-btl.mjs tree 3dmark03 2; make-btl.mjs zip list to_install/3dmark11/3dmark11.zip --depth=1`. tree: bytes and files under each folder to a depth, largest first, so a setup's leftovers stand out; zip list the same for an archive before unpacking it.

### Do our stdcall entries pop the bytes Windows' do?

[`checks/arg-bytes-audit.mjs`](checks/arg-bytes-audit.mjs): `node tools/checks/arg-bytes-audit.mjs <Wine spec directory> [--all]`

```
2641 stdcall entries checked, 0 pop a different number of bytes
```

From `arg-bytes-audit.mjs dbg/wine-specs`. Every stdcall entry of the win32 layer against its Wine spec; a line per entry that pops another number of bytes, each one a caller's stack moved a call at a time. Run by hand: the specs are fetched once (import-audit --fetch-specs) and not kept in the repository.

## Everything else

### `gates/`

- [`gates/probe.mjs`](gates/probe.mjs) - Does a browser, a page and a worker answer? (CI) (`npm run cdp:probe`)
- [`gates/triangle.mjs`](gates/triangle.mjs) - Does a guest program's draw reach the screen, four pixels exact? (`node tools/gates/triangle.mjs [--glsl]`)
- [`gates/shader-gate.mjs`](gates/shader-gate.mjs) - Do Direct3D 9 shaders translate as the reference machine computes them? (CI) (`npm run cdp:shaders`)
- [`gates/shader-clip.mjs`](gates/shader-clip.mjs) - Do the two paths of user clip planes agree? (`npm run cdp:clip`)
- [`gates/tess-gate.mjs`](gates/tess-gate.mjs) - Does the WGSL tessellator agree with the reference one? (CI) (`npm run cdp:tess`)
- [`gates/gs-gate.mjs`](gates/gs-gate.mjs) - Do geometry shaders and stream output write what Direct3D writes? (CI) (`npm run cdp:gs`)
- [`gates/vertex-pull-gate.mjs`](gates/vertex-pull-gate.mjs) - Do vertex streams a stage pulls itself match WebGPU's own fetch? (CI) (`npm run cdp:pull`)
- [`gates/gl-lighting-gate.mjs`](gates/gl-lighting-gate.mjs) - Does the GPU light a fixed-function OpenGL vertex as the CPU does? (`npm run cdp:lighting`)
- [`gates/spirv-gate.mjs`](gates/spirv-gate.mjs) - Does OpenGL's SPIR-V path compute what its GLSL source does? (`npm run cdp:spirv`)

### `checks/`

- [`checks/check-budget-writes.mjs`](checks/check-budget-writes.mjs) - The emitter writes a region's budget only as a count (`npm run check:boundaries`)
- [`checks/check-emit-options.mjs`](checks/check-emit-options.mjs) - Every emit option reaches the cache key (`npm run check:boundaries`)
- [`checks/check-guest-pointers.mjs`](checks/check-guest-pointers.mjs) - A handler faults on a bad guest pointer only as Windows does (`npm run check:boundaries`)
- [`checks/check-is-main.mjs`](checks/check-is-main.mjs) - No script decides it was started by comparing paths itself (`npm run check:boundaries`)
- [`checks/check-link-slots.mjs`](checks/check-link-slots.mjs) - One machine a slot of a process's link (`npm run check:boundaries`)
- [`checks/check-lock-release.mjs`](checks/check-lock-release.mjs) - A locked word is not released by a plain store (`npm run check:boundaries`)
- [`checks/check-overlapped-layout.mjs`](checks/check-overlapped-layout.mjs) - OVERLAPPED's offsets are written in one file (`npm run check:boundaries`)
- [`checks/check-package-files.mjs`](checks/check-package-files.mjs) - Core's package ships what its files import (`npm run check:boundaries`)
- [`checks/check-scan-windows.mjs`](checks/check-scan-windows.mjs) - A scan of guest memory stays in its region (`npm run check:boundaries`)
- [`checks/check-store-protocol.mjs`](checks/check-store-protocol.mjs) - A store's protocol is spoken only in GameHub (`npm run check:boundaries`)
- [`checks/check-volume-spread.mjs`](checks/check-volume-spread.mjs) - No volume is copied by object spread (`npm run check:boundaries`)
- [`checks/check-wall-bounds.mjs`](checks/check-wall-bounds.mjs) - No test bounds a wall-clock time (`npm run check:boundaries`)
- [`checks/check-wide-limits.mjs`](checks/check-wide-limits.mjs) - A UTF-16 read's limit is in bytes (`npm run check:boundaries`)
- [`checks/emit-digest.mjs`](checks/emit-digest.mjs) - The 32-bit translation is unchanged (--check against emit-digest.json) (`npm run check:boundaries`)
- [`checks/check-catalog.mjs`](checks/check-catalog.mjs) - Every file under tools/ is in this catalog, in its category, and every instrument has a real sample (`npm run check:boundaries`)

### `generators/`

- [`generators/x86-corpus.mjs`](generators/x86-corpus.mjs) - Rewrite the 32-bit instruction corpus a real processor answered (gcc -m32) (`node tools/generators/x86-corpus.mjs`)
- [`generators/x64-corpus.mjs`](generators/x64-corpus.mjs) - Rewrite the 64-bit instruction corpus (clang) (`node tools/generators/x64-corpus.mjs`)
- [`generators/x64-decode-fixture.mjs`](generators/x64-decode-fixture.mjs) - Rewrite the 64-bit decoder's reference from compiled code (`node tools/generators/x64-decode-fixture.mjs`)
- [`generators/bc-corpus.mjs`](generators/bc-corpus.mjs) - Rewrite the BC6H/BC7 decoder corpus (`node tools/generators/bc-corpus.mjs`)
- [`generators/tess-corpus.mjs`](generators/tess-corpus.mjs) - Rewrite the tessellator's corpus from Microsoft's reference tessellator (`node tools/generators/tess-corpus.mjs`)
- [`generators/gl-registry.mjs`](generators/gl-registry.mjs) - Rewrite OpenGL's command sizes from Khronos' gl.xml (`node tools/generators/gl-registry.mjs`)
- [`generators/glsl-functions.mjs`](generators/glsl-functions.mjs) - Rewrite GLSL's built-in functions from the GLSL specification (`node tools/generators/glsl-functions.mjs`)
- [`generators/steam-interfaces.mjs`](generators/steam-interfaces.mjs) - Rewrite the Steamworks interfaces' vtables from the SDK headers (`node tools/generators/steam-interfaces.mjs`)
- [`generators/uia-ids.mjs`](generators/uia-ids.mjs) - Rewrite UI Automation's identifiers from the SDK headers (`node tools/generators/uia-ids.mjs`)
- [`generators/crt-dictionary.mjs`](generators/crt-dictionary.mjs) - Rewrite cork's dictionary of C runtime signatures (`node tools/generators/crt-dictionary.mjs`)

### `ci/`

- [`ci/ci-layers.mjs`](ci/ci-layers.mjs) - Which packages does a push make CI check? (`run by .github/workflows/ci.yml`)
- [`ci/readme-links.mjs`](ci/readme-links.mjs) - A package's README links point at the commit published (`run by .github/workflows/publish.yml`)

### `lib/`

- [`lib/common.mjs`](lib/common.mjs) - isMain, options, a median, where bundles lie (BOTTLIFY_BUNDLES)
- [`lib/btl.mjs`](lib/btl.mjs) - The tools' path to core's bundle reader and writer
- [`lib/relay-option.mjs`](lib/relay-option.mjs) - --network and --roots for the runners
- [`lib/disk-directory.mjs`](lib/disk-directory.mjs) - A folder of this disk shaped as OPFS, for the translation store in Node
- [`lib/chromium-v8.mjs`](lib/chromium-v8.mjs) - Node's V8 set as Chromium's, for a tool that measures cork
- [`lib/cdp.mjs`](lib/cdp.mjs) - A Chrome DevTools Protocol client
- [`lib/browser.mjs`](lib/browser.mjs) - Find and launch a Chromium with a GPU and a CDP endpoint
- [`lib/server.mjs`](lib/server.mjs) - A static server for the pages, the sources and a bundle
- [`lib/connect.mjs`](lib/connect.mjs) - Attach to the shared browser and the launcher tab, for live.mjs
- [`lib/profile.mjs`](lib/profile.mjs) - Sample the engine's workers and fold a CPU profile, for game.mjs and frames.mjs
- [`lib/device-lag.mjs`](lib/device-lag.mjs) - How far the device is behind the engine, for game.mjs
- [`lib/frame-window.mjs`](lib/frame-window.mjs) - The frames a watched window holds, for frames.mjs
- [`lib/timeout-report.mjs`](lib/timeout-report.mjs) - What a run that did not answer leaves, for game.mjs and drive
- [`lib/thread-window.mjs`](lib/thread-window.mjs) - A --series window by thread and executor, for game.mjs

### `fixtures/`

- [`fixtures/make-pe.mjs`](fixtures/make-pe.mjs) - Build PE programs for the packages' tests
- [`fixtures/d3d9-program.mjs`](fixtures/d3d9-program.mjs) - A Direct3D 9 test program
- [`fixtures/gl-program.mjs`](fixtures/gl-program.mjs) - The pieces of an OpenGL test program
- [`fixtures/gl-glsl-program.mjs`](fixtures/gl-glsl-program.mjs) - An OpenGL 2.0 GLSL test program (also triangle.mjs --glsl)
- [`fixtures/spawn-program.mjs`](fixtures/spawn-program.mjs) - A parent-process test program
- [`fixtures/fake-graphics-worker.mjs`](fixtures/fake-graphics-worker.mjs) - A graphics worker over the fake GPU, for tests
- [`fixtures/cpu-time.mjs`](fixtures/cpu-time.mjs) - A thread's processor time, for tests that bound a cost

### `docs/`

- [`docs/site.mjs`](docs/site.mjs) - Build the documentation site from docs/ (npm run docs); check.mjs fails a link that leads nowhere (`npm run docs`)
