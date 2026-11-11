# Source and tests

## Source

| Part | Files | What it does |
| --- | --- | --- |
| Decoder | [`src/decode/`](../../modules/cork/src/decode/) | Turns bytes into instructions. The opcode tables are written by hand: for each instruction the decoder knows its operands, its length, which flags it reads and writes, and how it can fault. An unknown opcode stops it, named. |
| Region former | [`src/region.js`](../../modules/cork/src/region.js), [`src/helpers.js`](../../modules/cork/src/helpers.js), [`src/crt-dictionary.js`](../../modules/cork/src/crt-dictionary.js) | Forms a region from an entry. Recognises compiler helpers such as MSVC's `_ftol2`, and the C runtime's `memcpy`, `memmove`, `memset`, `strlen` and `sqrt` a program links in, by their bytes and puts what they do in place of the call (`emit/crt.js`), and forms a direct call to an import thunk (`jmp [slot]`) as the call through its slot. |
| Emitter | [`src/emit/`](../../modules/cork/src/emit/) | Turns a region into one WebAssembly function: integer instructions, flags, memory, the x87, MMX and SSE (`simd.js`), `lock`-prefixed instructions as atomics (`locked.js`), each in a file of its own. It works straight from the decoded instructions, with no intermediate language. |
| Encoder | [`src/wasm/`](../../modules/cork/src/wasm/) | Writes the WebAssembly bytes, and finds out what the engine supports (SIMD, tail calls). |
| Runtime | [`src/runtime/`](../../modules/cork/src/runtime/) | Everything around translation: the candidate queue, batches, translation workers (`translator.worker.js`), the shared memory finished code is kept in (`arena.js`), publishing, the entry hash, page flags (`pages.js`), dropping rewritten code, indirect call prediction, gathering small modules into big ones, the records kept in the translation store (`cache.js`), and what the executors of one process share about code (`shared-code.js`). |
| Interpreters | [`src/interp.js`](../../modules/cork/src/interp.js), [`src/fast.js`](../../modules/cork/src/fast.js), [`src/interp-wasm.c`](../../modules/cork/src/interp-wasm.c) | An interpreter in JavaScript for the very first steps, then one built from C into WebAssembly (in Bottlify; cork's own machine keeps to the JavaScript one). |
| Instruction model | [`src/ir.js`](../../modules/cork/src/ir.js), [`src/ir-x87.js`](../../modules/cork/src/ir-x87.js), [`src/ir-simd.js`](../../modules/cork/src/ir-simd.js) | A slow, simple account of what each instruction does. The JavaScript interpreter runs on it, and translated code is checked against it. |

How cork sits in Bottlify (loading by URL, the executor contract in
[`engine.js`](../../modules/core/src/layers/cpu/engine.js), threads, the translation pool, several executors
of one process) is in [cork in the engine](../architecture/cork.md).

## Testing

```sh
npm test -w @bottlify/cork                  # unit tests and gates, a minute or two
npm run test:integration -w @bottlify/cork  # the suites over the corpus
node modules/cork/bench/run.mjs             # the benchmark (bench/README.md)
```

- **Instruction corpus** ([`src/x86-corpus.json.gz`](../../modules/cork/src/x86-corpus.json.gz), in the
  repository): short random instruction sequences from templates written from the Intel SDM, run on
  a real processor by [`tools/x86-corpus.mjs`](../../tools/x86-corpus.mjs), which makes it again
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
  formed and published in parts against one formed whole (`runtime/forming-parts.test.js`),
  `lock`-prefixed instructions against the model (`emit/locked.test.js`), the corpus translated
  for a process's shared layout and run on its third executor against the hardware
  (`emit/corpus-shared.itest.js`).

Plain ES modules with JSDoc, tests on `node:test`. Licensed MPL-2.0.
