# The module system

How `@bottlify/core` is assembled from its layers: the contract every layer implements, how a
configuration becomes an ordered build plan, what a layer is allowed to see of the others, and how
the boundary checker enforces all of that in CI. Everything here lives in `src/system/` and
`src/core.js` (paths relative to `modules/core/`); the layers themselves are documented in
[`README.md`](./README.md) and one file per layer.

## 1. The contract (`src/system/contract.js`)

`contract.js` is JSDoc typedefs only and exports nothing at runtime. Every layer's `module.js`
exports one object of this shape, named `<layer>Module`:

| member | type | meaning |
|---|---|---|
| `name` | `string` | Unique within the package; the same string a consumer uses in the configuration and in `api(name)`. |
| `version` | `string` | Reported in diagnostics. |
| `requires` | `readonly string[]` | The interfaces this module consumes, by module name. Interfaces only, never implementations: the registry, the host and the boundary checker all read this array. |
| `create(config, host)` | `(ModuleConfig \| null, ScopedModuleHost) => Promise<ModuleApi>` | Builds the module and returns its API. `config` is the object from the configuration, or `null` for defaults. |
| `diagnostics()` | `() => ModuleDiagnostics` | Required for every module, and must answer after `create`. |
| `dispose()` | `() => Promise<void>` | Releases what `create` took. |

The other typedefs:

| typedef | shape |
|---|---|
| `ModuleApi` | `Record<string, any>` — the callable members other modules may reach through `requireApi`. |
| `ModuleConfig` | Serialisable data, validated by the module itself inside `create`. |
| `ModuleDiagnostics` | `{ name, version, status: 'created' \| 'ready' \| 'stub' \| 'disposed', metrics?, issues? }`. |
| `ScopedModuleHost` | `{ requireApi(name), provide(name, api) }` — the module's only view of the system. |
| `CoreInstance` | `{ modules, api(name), diagnostics(), dispose() }` — what `assembleModules` returns. |

### A module's live state belongs to its instance

`create()` may run more than once in the same realm: a process replacement runs it again on the
same worker, a child started beside its parent is a second graph built while the parent's stands,
and the plan for more than one machine in one worker needs two live at once. Every layer under
`src/layers/` follows the same shape so that this is safe: one `state` object is built inside
`create()`, every method the returned api hands out closes over that object rather than over a
module-level binding, and a `current` — reassigned to the new `state` at the end of each
`create()` — exists only so that `diagnostics()` and `dispose()`, which the contract puts on the
module rather than on the api, have something to reach. Nothing outside `create()` ever holds the
state itself, so a second `create()` cannot take the first instance's memory, threads, decoder,
volume or GPU backend out from under it.

`current` belongs to a module object, and every graph has module objects of its own: each layer's
`module.js` exports `create<Layer>Module()`, and `defaultModules()` calls every one of them for
each `assembleModules`. A child's graph therefore has its own `current` in every layer, and its
creation and its `dispose()` reach its own instances only — the parent's `diagnostics()` still
answers for the parent's, and the parent's `dispose()` still releases them. The `<layer>Module`
export is one graph's worth, made once, for the boundary check and for a test that builds one
layer alone; a build never shares it. What stays at file scope is what may be shared: tables,
constants, and caches of code already built.

`dispose()` marks its instance's `state.disposed` and drops `current`; it never reaches into a
different instance's state, so disposing the second machine leaves the first exactly as it was.
Every api method a disposed instance still holds a reference to answers rather than throwing: a
harmless value in the same shape a live call would have answered — an empty list, a null, a
no-op — for a layer whose calls have one, and the same refusal a disabled or not-yet-built layer
already answers (`system/stub.js`'s `NOT_IMPLEMENTED`) for a layer like `graphics` whose api
returns whole object graphs with no harmless scalar to stand in for them. `cpu` is the one further
step: a disposed instance answers exactly as one that has never booted, because from a caller's
side those are the same state, and `boot()`'s "already booted" refusal reads only its own
instance's state — never a different instance's emulator — so a fresh instance boots cleanly
while the one it is replacing is still running or already disposed.

## 2. Configuration (`src/system/config.js`)

`normalizeConfig(desired, known)` turns the caller's `{ [moduleName]: value }` into a
`Map<name, { enabled, config }>` with one entry per known module:

| value | result |
|---|---|
| `undefined` or `true` | enabled, `config: null` (defaults) |
| `false` or `null` | disabled |
| an object | enabled, `config` is that object |
| anything else | `Error` — thrown before any module is created |

A key that is not a known module name is an error, thrown first. The table is exhaustive: every
known module gets a toggle, whether or not the caller named it.

## 3. The registry and the build plan (`src/system/registry.js`)

`new ModuleRegistry(definitions)` takes the module objects and checks two things at construction:
no duplicate `name`, and every name in every `requires` is itself a definition. Both are
configuration errors, not runtime surprises.

`registry.resolve(desired)` produces the build plan, an ordered `PlanEntry[]` of
`{ name, module, config }`:

1. The configuration is normalised (section 2).
2. The **active set** is the closure of every enabled module over `requires`: enabling a module
   activates everything it requires, transitively, whether or not those were enabled.
3. The active set is **topologically sorted** over `requires` by depth-first search. A cycle is an
   error naming the module it was found through.
4. Each active name becomes a plan entry. An enabled module is planned as itself with its config;
   an active module that was **disabled** is planned as a stub (section 5) with `config: null`.

Two consequences follow. A disabled module that nothing enabled requires is not in the active set
at all and is dropped from the build (`core.api(name)` then throws `not part of this build`). A
disabled module that something does require is present as a stub, so the requiring module's
`requireApi` still answers and no layer has to special-case a missing dependency.

The default definition list is `src/layers/index.js` (`defaultModules()`), in this order: `log`,
`cpu`, `memory`, `kernel`, `bridge`, `loader`, `filesystem`, `media`, `win32`, `graphics`, `audio`,
`input`. That list is already in dependency order, and the sort preserves it, so a default build's
diagnostics come back in exactly that sequence (pinned by `src/layers/layers.test.js`).

## 4. The scoped host (`src/system/host.js`)

`makeScopedHost(owner, allowedNames, apis)` builds the `ScopedModuleHost` handed to one module's
`create`. There is exactly one `apis` map underneath the whole build, but no module ever holds it:
each gets a view limited to `allowedNames`, which `assembleModules` sets to the module's own name
plus its `requires`.

What the host refuses, each with an `Error`:

| call | refused when |
|---|---|
| `requireApi(name)` | `name` is not in the module's own `requires` — "did not declare dependency on" |
| `requireApi(name)` | the interface has not been created yet — creation order or a dependency cycle |
| `provide(name, api)` | `name` is not the module's own name — "cannot register foreign interface" |

The first refusal is the runtime half of the rule the boundary checker enforces statically
(section 7): a module reaches another only through a declared edge.

## 5. Stubs (`src/system/stub.js`)

`createStubApi(name)` is a `Proxy` whose every property is a function that throws an `Error` with
`code: 'NOT_IMPLEMENTED'` and the message `NOT_IMPLEMENTED: <module>.<method>`. Two properties are
exempt so the stub is not mistaken for something else: `marker` (the string `[stub:<name>]`) and
`then` (`undefined`, so an `await` does not treat it as a promise); symbol properties answer
`undefined`.

`createStubModule(name, version, requires = [])` wraps that in an immutable (`Object.freeze`) `BottlifyModule` whose
`diagnostics()` reports `status: 'stub'`. The registry installs stubs with an empty `requires`.

A stub is a valid state of a build, not a gap: a program that reaches a disabled layer fails loudly
at the call rather than receiving a plausible nothing.

## 6. Assembly (`src/core.js`)

`assembleModules(config = {})`:

1. Builds a `ModuleRegistry` from `defaultModules()` and resolves the plan.
2. For each entry in plan order, makes a scoped host with `allowedNames = { name, ...requires }`,
   awaits `module.create(config, host)`, and registers the result with `host.provide(name, api)`.
3. Returns a `CoreInstance`:

| member | behaviour |
|---|---|
| `modules` | The plan's module objects, in creation order. |
| `api(name)` | The API registered under `name`; throws `not part of this build` for anything else. |
| `diagnostics()` | One `ModuleDiagnostics` per module, in creation order. |
| `dispose()` | Awaits every module's `dispose` in reverse creation order. |

`assembleModules` is internal machinery, exported from the package for tooling and tests; the
product API is `createApp` ([`host.md`](./host.md)), whose engine (`src/app.js`) calls
`assembleModules` with one configuration object per layer and then wires the cross-cutting step the
graph deliberately does not express — binding a program's imports to the layers' exports.

Building the graph starts nothing: the `cpu` module's `create` does not boot the emulator, and
anything that needs a running guest throws `boot() must be called` until it is.

## 7. The layer dependency graph

This is what every `module.js` declares today, read from `src/layers/<name>/module.js`:

| layer | version | `requires` |
|---|---|---|
| `log` | 0.1.0 | — |
| `cpu` | 0.1.0 | — |
| `memory` | 0.1.0 | `cpu` |
| `kernel` | 0.1.0 | `cpu`, `memory`, `log` |
| `bridge` | 0.1.0 | `cpu`, `kernel`, `memory`, `log` |
| `loader` | 0.1.0 | `cpu`, `memory`, `log` |
| `filesystem` | 0.1.0 | `log` |
| `media` | 0.1.0 | `log` |
| `win32` | 0.2.0 | `bridge`, `kernel`, `memory`, `loader`, `filesystem`, `log` |
| `graphics` | 0.1.0 | `win32`, `bridge`, `memory` |
| `audio` | 0.1.0 | `win32`, `bridge`, `memory` |
| `input` | 0.2.0 | `win32`, `bridge`, `memory` |

Some edges are deliberately absent. `loader` does not require `win32` although it binds imports to
win32's exports: the binding belongs to whoever assembles the process (`src/app.js`), and an edge
would invert the graph. `win32` does not require `graphics`, `audio`, `media` or `input` although
`gdi32`, `winmm`, DirectShow and the cursor need them: those services arrive through win32's
*configuration* as thunks the assembler hands down (`config.graphics`, `config.output`,
`config.video`, `config.cursor` in `src/app.js`), resolved lazily through `core.api(...)` so that a
build without the upper layer answers a truthful failure instead of a cycle.

### What `scripts/check-boundaries.mjs` enforces

The script does not trust a separately maintained rule file. It imports each
`src/layers/<name>/module.js`, reads `<name>Module.requires`, then walks every `.js` and `.mjs`
under `src/` (skipping `*.test.*` and `*.itest.*`), classifies each file as `system`, `layer`,
`layers-index` or `root`, and reads every way the file reaches another module: an `import` or
`export ... from` statement, an `import()` of a string or of a template with nothing substituted
into it (read as the literal it is, a JSDoc `import('...')` type included, since that is a
dependency as much as a statement is), an `import()` of anything else, and a module-relative
`new URL('literal', import.meta.url)`. The rules live in `scripts/lib/boundaries.mjs`, with a test
that builds a tree for each form. Any of the following fails the build:

| rule | message |
|---|---|
| An import that resolves under `vendor/` from any file outside `src/layers/cpu/` | `vendor is reachable only from layers/cpu` |
| An import that resolves outside `src/` (other than the vendor case) | `imports outside src` |
| A `new URL(..., import.meta.url)` reaching outside `src/`, from anything but a root file or the cpu layer reaching `vendor/` | `reaches outside src by URL` |
| An `import()` of a computed argument from anything but the cpu layer or a root file -- the one form nothing here can check | `imports a module by a computed argument` |
| A package name other than the platform's `node:` modules | `the core has no dependencies` |
| An engine package (`@bottlify/cork`), which the cpu layer loads by URL when a launch selects it and the core must run without | `core must not depend on an engine package` |
| A `src/system/` file importing a layer or `src/layers/index.js` | `system must not know layers` |
| A layer file importing `src/layers/index.js` | `import the layer module directly` |
| A layer file importing another layer that is not in its own `requires` | `not declared in requires` |
| A layer file importing a `root` file (`src/core.js`, `src/app.js`, `src/host/*`, …) | `the facade is a consumer, not a dependency` |
| Any cycle in the import graph over `src/` | `Import cycle detected` |

Files classified `root` — `src/core.js`, `src/app.js`, `src/host/*`, `src/storage.js` and the
rest of `src/` outside `system/` and `layers/` — may import anything inside `src/`; they are the
consumers of the layers. The platform's `node:` modules are not outside `src/` in this sense; any
other bare specifier is refused, which is the checked half of the package's zero-runtime-dependency
rule, `package.json` having none the other.

Run it with `npm run check:boundaries`; CI runs it on every push.

## 8. Adding a layer

1. Create `src/layers/<name>/` with `api.js` (the JSDoc interface the module's API implements) and
   `module.js` exporting `<name>Module` — the export name is what the boundary checker looks for.
2. Declare `requires` as the exact list of layers the code imports or calls through `requireApi`.
   An undeclared import fails `check:boundaries`; an undeclared `requireApi` throws at `create`.
3. Add the module to `defaultModules()` in `src/layers/index.js`, after everything it requires.
4. Add it to `ALL_LAYERS` in `src/layers/layers.test.js`, which pins the default build's order.
5. Implement `diagnostics()` — it is not optional — and colocate `*.test.js` with the code.
6. If the assembler must hand it anything (a device, a clock, a thunk to a layer above it), that
   goes in the per-layer configuration block in `src/app.js`, never in a new import.

A layer that is switched off in a configuration is still a valid build: `assembleModules({ <name>:
false })` drops it or stubs it as section 3 describes, and nothing else changes.
