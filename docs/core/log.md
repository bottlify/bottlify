# `log` — the journal and the phase profiler

Source: `modules/core/src/layers/log/`. Module contract and host machinery: [`system.md`](./system.md),
[`host.md`](./host.md); layer index: [`README.md`](./README.md).

## 1. Purpose

`log` is what the engine says about itself while it runs, and where its time went. It is two
instruments over one kind of storage: a **journal** (levels, categories, a ring of recent records,
sinks) that answers "what happened", and a **phase profiler** (named, nestable phases tagged with
whose time they are, per-frame history) that answers "how long did it take and whose time was it".
Both are built to stay switched on in a shipping build: a rejected log call is a map lookup and a
comparison, a kept one fills a slot allocated at startup.

It is not a transport. The layer never formats, allocates or does I/O on the path being measured;
it never picks a console or a collector; and it does not own a clock. Sinks and the clock are
injected by whoever assembles the engine (`src/app.js` in this package). It requires nothing.

## 2. Contract

| field      | value |
|------------|-------|
| `name`     | `log` |
| `version`  | `0.1.0` |
| `requires` | `[]` |

### Configuration (`src/layers/log/module.js`, `src/layers/log/api.js`)

| option       | type                                   | default                         | meaning |
|--------------|----------------------------------------|---------------------------------|---------|
| `now`        | `() => number`                         | `() => 0`, and an issue is raised | The clock journal records are stamped with. The engine passes the guest's virtual clock, so a record carries the time the program itself would quote. |
| `wallClock`  | `() => number`                         | `performance.now`, else `Date.now` | The clock phases are measured against. Deliberately the host's, not the guest's: the guest clock is credited in lumps as the scheduler runs and would report a phase as what the guest was credited, not what it cost. |
| `level`      | level name or `Level` number           | `'info'`                        | The level of any category nobody names. |
| `categories` | `Record<string, level>`                | `{}`                            | Per-category levels. |
| `capacity`   | `number`                               | `4096`                          | Journal records held before the oldest is lapped. |
| `bytes`      | `number`                               | `1 MiB`                         | Bytes of record storage behind them; a record's bytes may be written over before its index slot is, and a reader is told either way. |
| `dictionary` | `number`                               | `512 KiB`                       | Bytes for the words records and tables refer to by id: templates, categories, thread and region and phase names. |
| `shared`     | `boolean`                              | `true`                          | Ask for `SharedArrayBuffer` where the platform has it. With `false`, or without cross-origin isolation, the same layout lives in an `ArrayBuffer` and the reader is on this thread. |
| `frames`     | `number`                               | `240`                           | Frames of profiler history kept. |
| `sinks`      | `((records) => void)[]`                | `[]`                            | Where `flush()` delivers detached copies. |

A level may be written as a name (`'debug'`, case-insensitive) or as a `Level` number; anything else
is a configuration error thrown by `toLevel` (`src/layers/log/internal/journal.js`). With no `now`
the layer still runs, but every timestamp reads as zero and `diagnostics().issues` says so.

### Provided API

| method | one line |
|--------|----------|
| `Level` | `{ OFF: 0, ERROR: 1, WARN: 2, INFO: 3, DEBUG: 4, TRACE: 5 }`, immutable (`Object.freeze`). A category's level is the least severe it keeps. |
| `PhaseKind` | `{ HOST: 'host', GUEST: 'guest', GPU: 'gpu', PRESENT: 'present' }`, immutable (`Object.freeze`). |
| `error(category, message, a?, b?, c?, d?)` … `trace(...)` | One writer per level. |
| `write(level, category, message, a?, b?, c?, d?)` | The general writer. `level` is a `Level` number. |
| `enabled(category, level)` | Whether a write at that level would be kept; worth asking only around work done solely to build the arguments. |
| `setLevel(category, level)` / `setDefaultLevel(level)` / `levelOf(category)` | Change or read the filter at runtime; names accepted. |
| `addSink(sink) → remove` | Register a sink; the returned function removes it. |
| `flush() → number` | Hands everything written since the last flush to every sink, as detached copies; returns how many. |
| `recent(count = 100)` | The tail of the ring, formatted, without moving the flush position. |
| `drain(since = 0, limit = 1000)` | `{ records, from, next, lost }` — everything from sequence `since`, where to resume, and how many records between `since` and `from` were written over before this read. |
| `templates()` | Every distinct message template seen, with its category, level and count, most frequent first. |
| `begin(name, kind = 'host')` | Open a phase. An unrecognised kind is `host`. |
| `end(name?, { instructions?, weight? }?) → ms` | Close the innermost phase; returns what the clock measured. A name that does not match is counted as an imbalance, never thrown. `weight` lets one timed phase stand for several in the sums, never in a single-occurrence figure. |
| `compiled(count = 1)` | Modules the emulator compiled during the open frame. |
| `note(name, amount)` | Any number the frame's owner counts into it, summed by name. |
| `beginFrame()` / `endFrame()` | Bracket one frame; `endFrame` returns a copy of the `FrameRecord`. |
| `frames(count = 240)` | The most recent completed frames, oldest first, as copies. |
| `profile(worst = 5)` | The snapshot: every phase by self time, the `worst` slowest frames, `hostShare`, imbalances. |
| `intern(text) → id` | The id a word is known by in the journal's dictionary, written once on first sight; -1 when the dictionary is full. For names a table stores as numbers. |
| `metrics` | The registry: `counters(layer, names) → Float64Array`, `table(layer, name, { rows, columns }) → TableWriter`, `onFrame(sampler) → remove`, `sample()`, `describe()`. A layer registers at `create` and writes in place from then on. |
| `memory()` | `{ journal, tables }` — the journal's block and every table's descriptor, for a reader on another thread. Made once per machine, after every layer has registered. A machine rebuilt on a child's image makes a fresh block, and the host hands that block to the keeper following the swap rather than rebuilding the reader. |

An instance owns its journal. `create()` may run more than once in the same realm (a process
replacement runs it again; the plan for two machines in one worker needs two at once), so each api
closes over its own instance and a second `create()` cannot take the first's ring; `diagnostics()`
answers for the most recently created instance. After `dispose()`, a call that was in flight is
accepted and does nothing: `enabled()` answers false, `write()` returns, `recent()` and `drain()`
answer empty, and nothing throws, because the contract of a writer that never waits and never
throws holds after disposal too.

`recent`, `drain`, `frames` and `profile` still answer from this thread, for the thread that owns
the engine and for the transition; each is a read of the same memory a reader elsewhere has, not a
walk of anything else. `endFrame()` also runs every registered sampler, which is the one moment
figures nobody keeps as they change are copied into their tables.

### `diagnostics()` metrics

| field | what it is |
|-------|------------|
| `journal.capacity` | Ring size. |
| `journal.written` | Records ever written; also the next sequence number. |
| `journal.lost` | Records lapped before any sink saw them — a gap reported rather than a silently shorter log. |
| `journal.rejected` | Calls refused by a level. |
| `journal.sinks` | Registered sinks. |
| `journal.defaultLevel`, `journal.categories` | The filter in effect. |
| `journal.templates` | Distinct templates seen. |
| `hostShare` | Over the whole frame history: host self time divided by frame wall time. |
| `frames` | Frames begun. |
| `averageFrameMs` | Mean wall time over the history. |
| `unbalancedPhases`, `imbalances` | Count of `end` calls that did not pair, and the first eight described by name. |
| `topPhases` | The sixteen phases with the most self time, as `name kind xcount self=… worst=…`. |

`issues` carries the "no clock configured" notice when `now` was not a function.

## 3. How it works

### The journal's memory (`src/layers/log/internal/shared-journal.js`)

One block, three regions, so that handing it over is one object: a dictionary of strings written
once each; an index of the last `capacity` records' byte offsets; a ring of `bytes` the records are
encoded into. A record is `length, sequence, time (f64), level, argc, topic id, template id`, then
its arguments — a number as a float64, anything else as UTF-16 code units of the string it prints
as. A template the dictionary has no room for travels inline instead (`INLINE_TEMPLATE`).

The writer reserves the record's bytes by storing the head with `Atomics.store` *before* writing
them, writes them, sets the index slot, then publishes the record count. A reader loads the count,
copies the record, and only then checks that the head has not reached its bytes and that the index
slot still names its sequence; a copy that fails either check is discarded and counted. That is
what makes "lost" exact per reader without the writer ever waiting: every counter is 32-bit and
compared by unsigned difference, exact until a reader falls 2^31 behind.

`createJournalCursor(memory)` is the decoding side — `word(id)`, `written()`, `oldest()`,
`read(sequence)` — used by the engine-side journal for its own `recent`/`drain`/`flush` and by
the reader below.

### Tables and the registry (`src/layers/log/internal/table.js`, `metrics.js`)

A table is rows of float64 columns behind a small header (`used` rows, `written` for a ring of
rows), with the column names published once in its descriptor. Float64 rather than an atomic
integer because a retired-instruction count passes 2^31 in seconds and the one writer is the engine
thread; an aligned eight-byte store is one instruction on every platform this runs on, and a torn
read would be one bad sample, not a bad count. Strings go in the journal's dictionary and a table
holds the id.

The registry hands tables out by layer and name, keeps the descriptors for `describe()`, runs the
samplers registered with `onFrame` when `endFrame()` closes a frame, and answers `find(layer, name)`
for the one case where a layer's row feeds another's. The profiler mirrors each closed frame into
`log/frames` (`FRAME_COLUMNS`) and every phase row into `log/phases` (`PHASE_COLUMNS`) as the row
changes.

Each frame's row also carries a copy of a few counters other layers keep, so that a single frame can
say why it was slow without a second run: `FRAME_DELTAS` names the cumulative ones — instructions
retired, `entries`, `interpretedSteps`, `f80Conversions`, `x87TagLost`, `slowWrites`,
`codePageWritesKept`, `hotnessLostToWrites`, `hostWrittenBytes` and `trapCrossings` — and
`FRAME_VALUES` the ones already per frame where they are written: which thread the machine was spent
on, what it retired, and the address the frame's heaviest slice began at. The samplers run *before*
the row is written, so a row holds the counters as they stood at its close. Nothing is computed on
the engine's thread: a mirrored column is one copy, and the subtraction that turns a cumulative
counter into the frame's own figure is the reader's. Where each column is read from is resolved once,
at the first frame, because the layers that own those rows are created after this one; a column no
layer answers reads zero and is reported in `diagnostics().issues`.

### The reader (`src/layers/log/internal/reader.js`, re-exported from `src/layers/log/reader.js`)

`createLogReader({ memory })`, where `memory` is what `log.memory()` answered, is the other side:
`poll(limit)` drains what was written since the last poll and hands it to subscribers —
`subscribe(topics, sink, { level })`, any number of them, each for the categories and the level it
wants — and counts exactly what it was lapped past; `recent(count)` and `drain(since, limit)` answer
what the engine-side calls used to; `counters(layer)`, `table(layer, name)`, `word(id)` read the
tables; `frames(count)`, `profile(worst)`, `guestByModule()` and `threads()` are the derived views
the diagnostics tables used to carry, computed on the reader's thread from the kernel's, the
memory's and the profiler's tables. Nothing here schedules itself: whoever owns the thread calls
`poll()`.

In the shipping host, that owner is a worker of its own — the keeper (`src/host/keeper.js`, run by
`src/host/log.worker.js`). It is handed a block, polls it on its own clock, keeps a history ring so
`recent` and `drain` cross a replacement, hands subscribers their records in batches, and answers
the page's reads. A `recent` or `drain` read polls the current block first, so a tail written since
the last tick — the lines a crash trace is made of — is answered without waiting for the clock; the
timer remains for a reader that is idle. `intervalMs: 0` runs no timer and a `{ type: 'poll', id }`
message runs one poll on request, which is how the keeper's test drives it. `base()` is the sequence
the current block begins at; a process replacement hands the keeper the next block, and its poll
cursor resumes there rather than counting the earlier sequences as lapped.

`frames(count)` answers each row as the engine-side record plus what only a reader can work out:
`instructions` and `counters` (each mirrored cumulative counter as this frame's own step, never
negative, and zero for the oldest row on the ring, which has no predecessor), `idleMs`,
`longestGuest.rate` in instructions per second, and `thread` — `{ name, instructions, at, module }`,
the module being the region the heaviest slice's address falls in, named from the memory layer's
regions table.

### The ring (`src/layers/log/internal/ring.js`)

`createRing(capacity, makeSlot)` builds every slot at construction and hands the same objects back
forever: `next()` returns the slot to overwrite, `written()` is the total ever written (which is
also the next sequence number), `oldest()` is the lowest sequence still present, and `each(from,
visit)` walks what survives from `from` upwards. A reader that fell behind gets the surviving tail,
not nothing. A slot belongs to the ring; a reader that keeps one copies it first.

### The journal (`src/layers/log/internal/journal.js`)

`write` is the path that must not cost the running program, and it is built around that:

- The reject test is `level === OFF || level > (levels.get(category) ?? fallback)` — one map lookup
  and one comparison, then `rejected++`.
- A kept record fills the slot `ring.next()` returns: sequence, `now()`, level, category, the
  message **as a template**, and the four arguments stored exactly as passed. The arguments are four
  separate parameters, not a rest list, because a rest list allocates an array on every call.
- Nothing is interpolated. `{0}` names an argument and `{0:x}` asks for it as hex; `format()` runs
  only when a reader asks (`flush`, `recent`, `drain`). An argument the template does not name is
  appended rather than dropped.
- The one allocation on the write path is the first sight of a new template, which creates its
  summary entry in the `templates` map. Every later write with the same template is a counter
  increment.

Reading is explicit and paid by the reader. `flush()` computes how many records were lapped since
the last flush (`lost`), then hands the sinks one batch of detached, formatted copies
(`FormattedRecord`: `sequence, time, level, levelName, category, message, args, text`). Flushing is
explicit because a sink is I/O, and I/O inside a guest call turns the log into the thing being
measured; the assembler decides when. `recent(count)` reads the tail without moving the flush
position — what a crash snapshot wants. `drain(since, limit)` reads forward from a sequence number
and returns `next` to resume from, `from` to say where it actually started and `lost` for how many
records between the two were written over before the read, so a live view that polls neither
repeats what it drew nor misses what happened in between; a caller further behind than the ring is
deep is told exactly how far rather than served a silent gap. The lap is also written into the log
as a `log` warning naming the count and the category most of the ring belongs to — the flood a
reader needs explained — once per burst and at most once a second of the journal's clock.

Ordering never depends on the clock: the sequence is monotonic, the time is whatever `now`
returned.

### The profiler (`src/layers/log/internal/profiler.js`)

A phase is opened with `begin(name, kind)` and closed with `end()`. The open-phase stack reuses its
entries by depth, so a phase costs no allocation. On `end`, the elapsed time is credited three ways:

- **Self time** is elapsed minus the elapsed of everything nested inside it. Attribution is by self
  time: a host phase wrapping a guest slice is charged only with its own overhead. This is what
  makes `hostShare` — the share of a frame spent in our code rather than in guest instructions —
  mean anything.
- **Worst** is the longest single occurrence, measured whole. For a phase entered from a guest call
  that is the longest the calling guest thread was held.
- The **open frame**, if any, accumulates self time by `PhaseKind`, remembers its longest phase and
  its longest guest slice (with the instruction count passed in `detail`), counts wait turns (a
  phase named `idle-*-wait`) and compiled modules, and sums whatever `note()` was told.

A `weight` passed to `end` says the phase stands for that many — a caller that times one crossing
in eight. It scales only what is summed over a window: a row's `count`, `totalMs` and `selfMs`,
and the frame's `sampled` (per kind, `(weight − 1)` × the phase's self time, the estimate for the
untimed ones). A row's `worstMs`, a frame's `longest` and its `byKind` split are what the clock
measured, so one long sampled crossing never reads as a freeze eight times its length, and a frame
never reports the guest at less than nothing. `snapshot().hostShare` over the window adds `sampled`
to `byKind`; a frame's own `hostShare` is measured only.

Frames are a ring of `FrameRecord`s (`index, startedAt, ms, byKind, sampled, hostShare, longest,
longestGuest, waits, compiles, idleMs, notes`), 240 deep by default; the frame still being measured
is never reported. `idleMs` is how much of the frame the machine had nothing of the program's to run
and was parked on us (any `idle-*` phase), which is what separates a frame we made long from a frame
the program or the emulator made long. `snapshot(worst)` sorts every phase row (`name, kind, count, totalMs, selfMs, worstMs`)
by self time, names the `worst` slowest frames, and takes `hostShare` over the whole history rather
than the last frame, because the threshold it serves is about sustained cost.

A mismatched or unpaired `end` is counted and, for the first eight, described (`end(x) while y open
at depth n`). It is never thrown: a profiler that takes the process down when the thing it measures
is already misbehaving has destroyed the evidence.

### Categories and areas

The layer has no fixed category list; a category is whatever string a writer passes. The engine
(`src/app.js`) establishes the convention that a host call is filed under a `call.<area>` category
— `call.cpu`, `call.gpu`, `call.audio`, `call.video`, `call.input`, `call.net`, `call.com`,
`call.hook` (a slot hook's crossings, written by the bridge: the frame at entry, and where the
call was sent afterwards) — and
configures every one of them `off` at creation, because a short run makes tens of thousands of host
calls and a reader who has not asked for them should pay a lookup, not a formatted line. The
`log.categories` option of `createApp` is spread over those defaults, so an area can be on from the
first instruction — which matters, since everything a program decides about a device it decides
while starting up. The application API re-exposes `drain`, `recent`, `setLevel`,
`setDefaultLevel`, `profile`, `frames`, and `areas()` (the list above, so a filter can offer an
area before anything in it has been logged). Two areas are the other end of the same question --
not what the program asked but what it was told, at `trace`: `input.press` is one line per
pointer press as it reached a window (button, up or down, the point, the message and its
parameters), and `input.message` is one line per message a window procedure received, whoever
sent it -- the queue, a `SendMessage`, or the window manager itself -- since what a program does
on a message (reset its device, pause, throttle itself) is decided in that procedure, and its
own calls never say what it was told. Every engine event is also written to the journal
under the event's name as its category (`divergence`, `unimplemented`, `bundle-retry`, …).

## 4. Limitations and divergences

- **No clock, no time.** Without `now` every record time and every duration is zero. The layer does
  not reach for `Date` on its own; it reports the omission in `diagnostics().issues`.
- **Levels are numbers on the write path.** `write` compares `level` numerically and does no
  conversion; a caller that passes a level *name* to `write` bypasses the filter (the string
  compares as neither `OFF` nor greater than any number) and the record is stored with the string as
  its level (`levelName` still renders, because `detach` falls back to `String(level)`).
  `setLevel`/`setDefaultLevel` do convert names. `src/app.js` currently writes engine events this
  way (`journal.write(SEVERITY[name] ?? 'info', …)`), so event records are always kept and cannot
  be filtered by level until the caller passes `Level` numbers or `write` applies `toLevel`.
- **Four arguments per record.** A fifth is not carried.
- **Sinks see nothing until `flush()`.** A run that never flushes still has `recent()` and
  `drain()`; a sink attached late sees only what has not been lapped.
- **Profiler phases are global, not per thread.** The stack is one stack; phases opened on behalf
  of different guest threads must still nest.
- **`imbalances` is capped at eight names**; beyond that only `unbalancedPhases` grows.
- **Arguments that are not numbers are stringified when written.** A string argument is copied
  into the ring as it is; an object becomes `String(value)` at the call, which is what a reader
  would have made of it anyway. Strings are cut at 1024 code units.
- **The dictionary is append-only and bounded.** A word it cannot hold is counted
  (`journal.unnamed`); a template then travels inline, a category reads as `#65535`, a table's name
  id as -1. Half a megabyte holds tens of thousands of words, so this is an alarm, not a case.
- **Tables are sampled, not transactional.** A reader may see a row from between two stores of one
  frame; the next frame corrects it.
- **The engine still answers `recent`/`drain`/`frames`/`profile` on its own thread** for whoever
  calls them there; those calls read the same memory and cost what the reader would have paid, on
  the wrong thread. In a normal run nothing calls them: the host's keeper worker reads the block
  instead. On an origin without shared memory the block cannot cross, so the engine's own reader
  answers the derived views and the page relays `drain` records to the keeper.

## 5. Tests

All are `node:test` unit tests with a hand-stepped clock; run with `npm test` from `modules/core`
(`node --test "src/**/*.test.js"`).

| file | covers |
|------|--------|
| `src/layers/log/internal/ring.test.js` | Slots are made once and reused; a lagging reader gets the surviving tail; `each` visits only what was asked. |
| `src/layers/log/internal/shared-journal.test.js` | A record round-trips with numbers as numbers and words by id; non-string arguments stringify; layout from options; an inline template when the dictionary is full; lapped sequences refused and counted exactly; bytes written over under a live index slot refused; the writer never waits and never grows (200 k records, under 10 µs each); a `worker_threads` reader sees every record whole and in order. |
| `src/layers/log/internal/table.test.js` | A store where it happens is what a reader picks up; a ring of rows reads oldest first; a reader on another thread sees a later store. |
| `src/layers/log/internal/metrics.test.js` | Counters registered once and updated in place; a duplicate name refused; samplers run on `sample()` only. |
| `src/layers/log/internal/reader.test.js` | Subscribers get their topics at their level; removal; `recent`/`drain` as the engine answered them; exact lost count on a lagging poll; counters and tables read from the same memory; a reader on another thread drains without the engine answering; `guestByModule` from the kernel's pages and the memory's regions; frames and the profile from the profiler's tables; a frame's mirrored counters read back as its own figures — the oldest row claiming none, a counter that went backwards reporting none, an interpret burst landing in the frame that had it, and the thread, module and worst-slice rate named. |
| `src/host/log.worker.test.js` | The keeper on a thread that did not write the journal, driven with no timer (`intervalMs: 0`) and an explicit `poll` per batch: reads answered by request, subscriber batches by topic and level (one batch per poll, not one message a record), a `recent`/`drain` right after the writes catching the tail up with no poll from the caller, and a second block attached with a continuing `sequenceBase` resolving a cursor from the first with nothing reported lost. |
| `src/layers/log/internal/journal.test.js` | Level filtering; the message stays a template until read; unnamed arguments appended; timestamps from the clock, order from the sequence; sinks get detached copies once; lapped records counted; `recent` does not move the flush position; template summary; level names; bounded storage; `drain` semantics, resume, limit and gap reporting. |
| `src/layers/log/internal/profiler.test.js` | Self time excludes nested phases; total/self/worst per phase; imbalances counted and named, never thrown; phases outside a frame; frame history laps; `hostShare` over the history; a frame's worst moment; notes; weighted phases scale the sums and never a single occurrence; a frame reports how long the machine was parked on us and resets it; closing a frame stores one row of fixed width whatever the frame held; mirrored columns copied from the sources given and zero for the rest. |
| `src/layers/log/module.test.js` | The module keeps its contract; configuration by name; the no-clock issue; diagnostics carry `hostShare`; phases use the host clock, not the guest's; sub-millisecond resolution without a configured clock; the phase table holds the loop and the calls together. |
