# @bottlify/cork

Cork is a user-mode x86-32 → WebAssembly translator with a runtime: it translates a program's
code ahead of execution into wasm functions the browser compiles to native code, and runs them
with the guest's flat memory as their memory. It is one of the execution engines
`@bottlify/core`'s `cpu` layer can run a program on; the vendored emulator is the other.

The package is separate from the core on purpose. A launch that selects the emulator runs with
this package absent, so the core never imports it: the `cpu` layer defines the executor
contract (`modules/core/src/layers/cpu/engine.js`) and loads an engine by a module URL given in
its configuration, the way it loads the emulator. This package's `createEngine` implements that
contract for 32-bit code; a 64-bit engine is expected to be a package of its own on the same
seam, reusing the building blocks exported here (`./wasm`, `./runtime`).

Nothing here needs the emulator. The emulator is used only by this package's integration
tests, as the oracle the differential harness compares translated code against; those tests
also need the nasm instruction corpus (`npm run fetch:corpus`, pinned by `corpus-lock.json`,
fetched into the gitignored `vendor/`), every case of which is run on the emulator through
this project's own machine and compared with the state real hardware recorded.

Design: `roadmap/cork-x86-translator.md`. Plan: `roadmap/cork-plan.md`. Zero runtime
dependencies; vanilla ES modules with JSDoc; tests are `node:test`, colocated (`*.test.js`
without the emulator, `*.itest.js` with it).
