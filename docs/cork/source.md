# Source and tests

## Source

| Part | Files | What it does |
| --- | --- | --- |
| Decoder | [`src/decode/`](../../modules/cork/src/decode/) | Turns bytes into instructions. The opcode tables are written by hand: for each instruction the decoder knows its operands, its length, which flags it reads and writes, and how it can fault. An unknown opcode stops it, named. |
| Region former | [`src/region.js`](../../modules/cork/src/region.js), [`src/helpers.js`](../../modules/cork/src/helpers.js), [`src/crt-dictionary.js`](../../modules/cork/src/crt-dictionary.js) | Forms a region from an entry, its small callees formed in whole or not at all. Recognises the compiler's helpers and the C runtime's functions a program links in by their bytes and puts what they do in place of the call (`emit/crt.js`; the list is in [How cork works](how-it-works.md#functions-cork-knows-by-their-bytes)), and forms a direct call to an import thunk (`jmp [slot]`) as the call through its slot. |
| Emitter | [`src/emit/`](../../modules/cork/src/emit/) | Turns a region into one WebAssembly function: integer instructions, flags, memory, the x87, MMX and SSE (`simd.js`), `lock`-prefixed instructions as atomics (`locked.js`), each in a file of its own. It works straight from the decoded instructions, with no intermediate language. |
| Encoder | [`src/wasm/`](../../modules/cork/src/wasm/) | Writes the WebAssembly bytes, and finds out what the engine supports (SIMD, tail calls). |
| Runtime | [`src/runtime/`](../../modules/cork/src/runtime/) | Everything around translation. `runtime.js` assembles it and runs regions (`run`, the host's notes); its parts are made over one state object (`state.js`, the settings in `settings.js`), each in a file of its own: the candidate queue (`queue.js`), forming batches under the engine thread's time credit (`forming.js`), the translation workers (`translators.js`, `translator.worker.js`), the translation store's keys and lookups (`store.js`, its records in `cache.js`), publishing (`publish.js`), the modules translated code lives in and their eviction (`modules.js`), the published regions (`regions.js`), the variants a region is formed in (`variants.js`), dropping rewritten code (`code-writes.js`), relinks, merges, indirect call prediction and copies (`relink.js`) and the diagnostics (`diagnostics.js`). Beside them: the shared memory finished code is kept in (`arena.js`), the entry hash (`entries.js`), page flags (`pages.js`), the compiled modules and formed regions the processes sharing a store share (`shared-modules.js`, `shared-forms.js`), and what the executors of one process share about code (`shared-code.js`). |
| Interpreters | [`src/interp.js`](../../modules/cork/src/interp.js), [`src/fast.js`](../../modules/cork/src/fast.js), [`src/interp-wasm.c`](../../modules/cork/src/interp-wasm.c) | An interpreter in JavaScript for the very first steps, then one built from C into WebAssembly (in Bottlify; cork's own machine keeps to the JavaScript one). |
| Instruction model | [`src/ir.js`](../../modules/cork/src/ir.js), [`src/ir-x87.js`](../../modules/cork/src/ir-x87.js), [`src/ir-simd.js`](../../modules/cork/src/ir-simd.js) | A slow, simple account of what each instruction does. The JavaScript interpreter runs on it, and translated code is checked against it. |

How cork sits in Bottlify (loading by URL, the executor contract in
[`engine.js`](../../modules/core/src/layers/cpu/engine.js), threads, the translation pool, several executors
of one process) is in [cork in the engine](../architecture/cork.md).

## Testing

```sh
npm test -w @bottlify/cork                  # unit tests and gates, a minute or two
npm run test:integration -w @bottlify/cork  # the suites over the corpus, and the gates
node modules/cork/bench/run.mjs             # the benchmark (bench/README.md)
node modules/cork/bench/micro/run.mjs       # what the benchmark does not cover, x86-64 too
node tools/bench/stand.mjs                  # the stand: the work recorded, and the speed here
node tools/bench/serve.mjs                  # the same stand as a page, for any browser
```

- **Instruction corpus** ([`src/x86-corpus.json.gz`](../../modules/cork/src/x86-corpus.json.gz), in the
  repository): short random instruction sequences from templates written from the Intel SDM, run on
  a real processor by [`tools/generators/x86-corpus.mjs`](../../tools/generators/x86-corpus.mjs), which makes it again
  with clang, lld and llvm-mc on an x86-64 Linux host. Each case goes through the decoder, both
  interpreters and translated code, and the result has to match the hardware; what is not compared,
  and why, is in [`src/testing/x86-corpus.js`](../../modules/cork/src/testing/x86-corpus.js), and
  the cases an engine still gets wrong are listed with their reasons in
  [`src/testing/x86-known.js`](../../modules/cork/src/testing/x86-known.js).
- **Sequence corpus** ([`src/testing/sequences-judge.js`](../../modules/cork/src/testing/sequences-judge.js)):
  generated chains of instructions run on the model and in translated code and are compared bit for
  bit.
- **Gates**: every fast path has a slow twin, and the two are compared on generated programs.
  Translated against interpreted (`machine.test.js`), a worker's translation against one on the
  same thread (`runtime/translators.test.js`), the shared arena (`runtime/arena.test.js`), a batch
  formed and published in parts against one formed whole (`runtime/forming-parts.test.js`), a
  process started again on the modules an earlier one compiled and the regions it formed against
  one making them (`runtime/run-shared.itest.js`),
  `lock`-prefixed instructions against the model (`emit/locked.test.js`), the corpus translated
  for a process's shared layout and run on its third executor against the hardware
  (`emit/corpus-shared.itest.js`).
- **Region shapes** ([`src/region-shapes.itest.js`](../../modules/cork/src/region-shapes.itest.js)):
  what a worse region does to a program is only slower, never wrong, so the corpus gates cannot
  see it. This gate counts how each micro workload, 32-bit and x86-64, moves between its regions
  once warm (transfers, calls and returns that leave, jumps through the dispatch) and holds the
  counts to the ones recorded in `src/testing/region-shapes.json`, within each workload's own
  spread. A workload whose counts its run's timing decides is listed there with the cause and
  skipped. A change that moves shapes on purpose records them again
  (`CORK_SHAPES_WRITE=5 node --test modules/cork/src/region-shapes.itest.js`).
- **The guest's own clock** (`clock: 'virtual'`, [settings](settings.md)): a run on it
  translates the same code however busy the machine is, which
  [`virtual-clock.test.js`](../../modules/core/src/layers/cpu/internal/virtual-clock.test.js)
  checks against a clock that jumps.
- **The stand** ([`tools/bench/`](../../tools/bench/)): the micro workloads on the guest's own
  clock, so each one's work (instructions, regions, every way between regions) is the same on any
  machine and in any browser, held to `tools/bench/expected.json`; its speed is the machine's,
  with the noise of its rounds beside it. The page runs it in a person's own browser;
  `npm run cdp:bench` runs the page in Chromium and holds its work to the record Node made.
  `tools/bench/build.mjs --arm A=REV --arm B=.` makes the page with two builds of cork as static
  files, run on a device several times over with B's speed against A's in each run. A change that
  makes cork form otherwise records it again (`node tools/bench/stand.mjs --write`).

## Judging a change

Each stand answers one question, and a number from one is no evidence for another's. A change to
cork is accepted when it is still right, is no slower on 32-bit and on x86-64 code, and is faster,
smaller, simpler or holds less memory. It is judged in this order, the exact counts before any
time, each arm a checkout of its own (a worktree or a copy, never the tree being edited):

| Question | Run | How |
| --- | --- | --- |
| Is it still right? | `npm test -w @bottlify/cork`, `npm run test:integration -w @bottlify/cork` | Always, both. A change that reaches the core's cpu layer also runs `node --test "src/layers/cpu/**/*.test.js" "src/layers/cpu/**/*.itest.js"` in `modules/core`. |
| Did the 32-bit translation change at all? | `node tools/checks/emit-digest.mjs --check` | A change meant to keep it fails here if it did not. One meant to change it writes the digest (`--write`) and raises `CACHE_VERSION`. |
| Do regions still move between each other as recorded? | `region-shapes.itest.js` (in the integration run), `node tools/bench/stand.mjs --work` | A change that moves them on purpose records both again (`CORK_SHAPES_WRITE=5`, `stand.mjs --write`). |
| What does translated code cost to run? | [`tools/translator/run-count.mjs`](../../tools/translator/run-count.mjs) `--qemu DIR --root BASE --root NEW` | Exact: machine instructions an iteration of each micro workload, 32-bit and x86-64 (the default `--bits both`, 100 warm, 20 counted). Read each workload's ratio, not only the geometric mean; the square bracket is what one of the guest's own instructions cost, and the last line the workloads by it, the dearest first. |
| What does translating cost? | [`tools/translator/emit-count.mjs`](../../tools/translator/emit-count.mjs) `--qemu DIR --root BASE --root NEW` | Exact. Judge by the work, V8's own compiles apart; the price list says where the cost moved. Same wasm bytes unless the change meant otherwise. |
| What machine code does a form become? | [`tools/translator/cork-asm.mjs`](../../tools/translator/cork-asm.mjs) | With `--runner` a node whose V8 is the browsers' (node 22's is older and spills where they do not); arm64 through an arm64 node under `qemu-aarch64`. Its static weighing is a model: compare arms, never absolutes. |
| What does a module hold in memory? | [`tools/translator/module-memory.mjs`](../../tools/translator/module-memory.mjs) | `node --expose-gc`, with each of the three flag sets its comment names. |
| Is it faster on this machine? | `node tools/bench/stand.mjs --roots BASE,NEW` | Ten runs on a quiet machine, alternated; one run's rounds vary by a fifth. Only to confirm what the counts said. |
| Is it faster on a person's device? | `node tools/bench/build.mjs --arm base=REV --arm new=.`, then the page (`serve.mjs --dir OUT`) | Five runs on the device; `--check` with `CDP_TEST_CHROME` holds the page's work to the record first. |
| Is everything else still right? | the full set in the repository's rules | Before anything goes to main. |

Nothing else runs beside a timed run on the same machine (a count does not depend on the load),
and no source of an arm is edited while a suite runs from it. A result that did not pay goes into
[`roadmap/negative-results.md`](../../roadmap/negative-results.md) with its numbers.

Plain ES modules with JSDoc, tests on `node:test`. Licensed MPL-2.0.
