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
| `frames`     | `number`                               | `240`                           | Frames of profiler history kept. |
| `sinks`      | `((records) => void)[]`                | `[]`                            | Where `flush()` delivers detached copies. |

A level may be written as a name (`'debug'`, case-insensitive) or as a `Level` number; anything else
is a configuration error thrown by `toLevel` (`src/layers/log/internal/journal.js`). With no `now`
the layer still runs, but every timestamp reads as zero and `diagnostics().issues` says so.

### Provided API

| method | one line |
|--------|----------|
| `Level` | `{ OFF: 0, ERROR: 1, WARN: 2, INFO: 3, DEBUG: 4, TRACE: 5 }`, frozen. A category's level is the least severe it keeps. |
| `PhaseKind` | `{ HOST: 'host', GUEST: 'guest', GPU: 'gpu', PRESENT: 'present' }`, frozen. |
| `error(category, message, a?, b?, c?, d?)` … `trace(...)` | One writer per level. |
| `write(level, category, message, a?, b?, c?, d?)` | The general writer. `level` is a `Level` number. |
| `enabled(category, level)` | Whether a write at that level would be kept; worth asking only around work done solely to build the arguments. |
| `setLevel(category, level)` / `setDefaultLevel(level)` / `levelOf(category)` | Change or read the filter at runtime; names accepted. |
| `addSink(sink) → remove` | Register a sink; the returned function removes it. |
| `flush() → number` | Hands everything written since the last flush to every sink, as detached copies; returns how many. |
| `recent(count = 100)` | The tail of the ring, formatted, without moving the flush position. |
| `drain(since = 0, limit = 1000)` | `{ records, from, next, lost }` — everything from sequence `since`, and where to resume. |
| `templates()` | Every distinct message template seen, with its category, level and count, most frequent first. |
| `begin(name, kind = 'host')` | Open a phase. An unrecognised kind is `host`. |
| `end(name?, { instructions?, weight? }?) → ms` | Close the innermost phase. A name that does not match is counted as an imbalance, never thrown. `weight` lets one timed phase stand for several. |
| `compiled(count = 1)` | Modules the emulator compiled during the open frame. |
| `note(name, amount)` | Any number the frame's owner counts into it, summed by name. |
| `beginFrame()` / `endFrame()` | Bracket one frame; `endFrame` returns a copy of the `FrameRecord`. |
| `frames(count = 240)` | The most recent completed frames, oldest first, as copies. |
| `profile(worst = 5)` | The snapshot: every phase by self time, the `worst` slowest frames, `hostShare`, imbalances. |

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
and returns `next` to resume from and `from` to say where it actually started, so a live view that
polls neither repeats what it drew nor misses what happened in between; a caller further behind
than the ring is deep is told so rather than served a silent gap.

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

Frames are a ring of `FrameRecord`s (`index, startedAt, ms, byKind, hostShare, longest,
longestGuest, waits, compiles, notes`), 240 deep by default; the frame still being measured is never
reported. `snapshot(worst)` sorts every phase row (`name, kind, count, totalMs, selfMs, worstMs`)
by self time, names the `worst` slowest frames, and takes `hostShare` over the whole history rather
than the last frame, because the threshold it serves is about sustained cost.

A mismatched or unpaired `end` is counted and, for the first eight, described (`end(x) while y open
at depth n`). It is never thrown: a profiler that takes the process down when the thing it measures
is already misbehaving has destroyed the evidence.

### Categories and areas

The layer has no fixed category list; a category is whatever string a writer passes. The engine
(`src/app.js`) establishes the convention that a host call is filed under a `call.<area>` category
— `call.cpu`, `call.gpu`, `call.audio`, `call.video`, `call.input`, `call.net`, `call.com` — and
configures every one of them `off` at creation, because a short run makes tens of thousands of host
calls and a reader who has not asked for them should pay a lookup, not a formatted line. The
`log.categories` option of `createApp` is spread over those defaults, so an area can be on from the
first instruction — which matters, since everything a program decides about a device it decides
while starting up. The application API re-exposes `drain`, `recent`, `setLevel`,
`setDefaultLevel`, `profile`, `frames`, and `areas()` (the list above, so a filter can offer an
area before anything in it has been logged). Every engine event is also written to the journal
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

## 5. Tests

All are `node:test` unit tests with a hand-stepped clock; run with `npm test` from `modules/core`
(`node --test "src/**/*.test.js"`).

| file | covers |
|------|--------|
| `src/layers/log/internal/ring.test.js` | Slots are made once and reused; a lagging reader gets the surviving tail; `each` visits only what was asked. |
| `src/layers/log/internal/journal.test.js` | Level filtering; the message stays a template until read; unnamed arguments appended; timestamps from the clock, order from the sequence; sinks get detached copies once; lapped records counted; `recent` does not move the flush position; template summary; level names; bounded storage; `drain` semantics, resume, limit and gap reporting. |
| `src/layers/log/internal/profiler.test.js` | Self time excludes nested phases; total/self/worst per phase; imbalances counted and named, never thrown; phases outside a frame; frame history laps; `hostShare` over the history; a frame's worst moment; notes; weighted phases. |
| `src/layers/log/module.test.js` | The module keeps its contract; configuration by name; the no-clock issue; diagnostics carry `hostShare`; phases use the host clock, not the guest's; sub-millisecond resolution without a configured clock; the phase table holds the loop and the calls together. |
