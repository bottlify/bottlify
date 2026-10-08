# @bottlify/cork

Cork is a user-mode x86-32 → WebAssembly translator with a runtime: it translates a program's
code ahead of execution into wasm functions the browser compiles to native code, and runs them
with the guest's flat memory as their memory. It is the execution engine `@bottlify/core`'s `cpu`
layer runs a program on by default, and the only one the core package carries; a v86 emulator a
caller brings is the other.

The package is separate from the core on purpose. The core never imports it: the `cpu` layer
defines the executor contract (`modules/core/src/layers/cpu/engine.js`) and loads an engine by a
module URL given in its configuration. This package's `createEngine` implements that contract for
32-bit code; a 64-bit engine is expected to be a package of its own on the same seam, reusing the
building blocks exported here (`./wasm`, `./runtime`).

Nothing here needs an emulator. The integration tests judge the translator two ways. The nasm
instruction corpus (`npm run fetch:corpus`, pinned by `corpus-lock.json`, fetched into the
gitignored `vendor/`) runs every case through the decoder, both interpreter tiers and translated
code, and the three that execute it are held to the state real hardware recorded. The sequence
corpus (`testing/sequences-judge.js`, `emit/sequences-N.itest.js`) runs generated runs of
instructions on cork's own instruction model -- the JavaScript interpreter over `ir.js`,
`ir-x87.js` and `ir-simd.js`, with no wasm tier -- and on translated code, and compares the two
bit for bit.

Emitting and compiling run in translation workers (`runtime/translator.worker.js`): the runtime
opens `translators` of its own, or a host's pool lends it workers (`attachTranslator`,
`detachTranslator`), each with a batch of its own out. What they emitted is kept for the process,
not for a worker: an arena of shared memory (`runtime/arena.js`) every translator of the process
reads and adds to, so a relink takes again what any of them emitted. Their gates are
`runtime/translators.test.js` and `runtime/arena.test.js`.

Where it goes next: `roadmap/v2/`. Zero runtime
dependencies; vanilla ES modules with JSDoc; tests are `node:test`, colocated (`*.test.js` for
units, `*.itest.js` for the corpus suites).
