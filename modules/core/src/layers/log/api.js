/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * log layer -- journaling (dependency module ✦).
 *
 * Responsibilities (master plan section 6): levels, categories, ring buffers,
 * sinks -- and, on the same storage, the phase profiler that answers where a
 * frame went. Requires nothing.
 *
 * Both instruments are meant to stay on in a build that ships. A rejected log
 * call is a map lookup and a comparison; a kept one fills a slot that already
 * exists and stores its arguments as they were passed, leaving the message a
 * template until a reader asks for it. Nothing here formats, allocates or does
 * I/O on the path being measured.
 *
 * Configuration:
 *
 * ```js
 * {
 *     now: () => number,              // required in practice; see below
 *     level: 'info',                  // level of a category nobody names
 *     categories: { cpu: 'debug' },   // per-category levels
 *     capacity: 4096,                 // records held before the oldest is lapped
 *     frames: 240,                    // frames of profiler history
 *     sinks: [records => {}],         // where flushed records go
 * }
 * ```
 *
 * A level may be written as a name or as a `Level` number; anything else is a
 * configuration error. With no clock the layer still runs, but every timestamp
 * and duration reads as zero and `diagnostics().issues` says so -- deliberately,
 * rather than reaching for a clock this layer is not allowed to know about.
 *
 * The API a consumer sees:
 *
 * - `error|warn|info|debug|trace(category, message, a?, b?, c?, d?)`, and
 *   `write(level, category, message, a?, b?, c?, d?)`
 * - `enabled(category, level)`, `setLevel(category, level)`,
 *   `setDefaultLevel(level)`, `levelOf(category)`
 * - `addSink(sink) -> remove`, `flush()`, `recent(count?)`,
 *   `drain(since?, limit?)`, `templates()`
 * - `begin(name, kind?)`, `end(name?)`, `beginFrame()`, `endFrame()`,
 *   `frames(count?)`, `profile(worst?)`
 * - the `Level` and `PhaseKind` vocabularies
 *
 * The message is a template, not a built string: `{0}` names an argument and
 * `{0:x}` asks for it as hex. Up to four arguments travel, passed separately
 * rather than as a rest list, because a rest list allocates on every call. An
 * argument the template does not name is appended rather than dropped.
 *
 * Sinks are handed detached copies, and only when `flush()` is called. Flushing
 * is explicit because a sink is I/O, and doing I/O inside a guest call turns
 * the log into the thing being measured; whoever assembles the engine decides
 * when that happens. `recent()` reads the ring without disturbing the flush
 * position, which is what a crash snapshot wants; `drain()` reads forward from
 * a sequence number and says where to resume, which is what a live view of a
 * running process wants -- asking for "the last hundred" repeatedly either
 * repeats what is already on screen or loses what happened in between. Records lapped before a sink
 * saw them are counted, so a gap is reported rather than silent.
 *
 * Phases are named, nestable and tagged with a `PhaseKind` -- ours, the guest's,
 * the GPU's, presentation. Accounting is by self time: a phase of ours wrapping
 * a guest call is credited only with its own overhead, which is what makes
 * `hostShare` -- the share of a frame spent in our code rather than executing
 * guest instructions, the metric section 21 watches -- mean anything. Each phase
 * also keeps its worst single self time; for a phase entered from a guest call
 * that is the longest the calling guest thread was held.
 *
 * @typedef {import("../../system/contract.js").ModuleConfig} Config
 */
