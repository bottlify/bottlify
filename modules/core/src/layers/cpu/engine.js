/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The executor contract: what an execution engine gives the cpu layer.
 *
 * The layer runs a program on one of two engines -- the vendored emulator,
 * adapted by `internal/v86-host.js`, or a translator package such as
 * `@bottlify/cork`, loaded at `boot()` by the module URL in the layer's
 * configuration, the way the emulator is. This file is the whole of what the
 * two sides agree on: an engine package implements these names, the layer's
 * hosts (`internal/hybrid-host.js`, `internal/cork-host.js`) compose a runtime
 * with the layer's own contexts, traps and faults. Typedefs only; nothing here
 * runs, and the layer never imports an engine package -- a launch that selects
 * the emulator runs with every engine package absent.
 *
 * Every field is sized for 32-bit code today and named so that a 64-bit engine
 * implements the same contract with `bits: 64` rather than a second one.
 */

/**
 * Where each register lives in the memory a runtime executes over, as byte
 * offsets. Translated code addresses registers by these constants, so the
 * layout is part of every translation's identity (`id`).
 *
 * In hybrid mode the offsets are the emulator's own register file inside its
 * exported memory, read off its typed views at boot; the state block *is* the
 * emulator's, and a switch between the two executors copies nothing. In an
 * engine-alone mode the layout is the engine's own.
 *
 * @typedef {Object} StateLayout
 * @property {32 | 64} bits        The register width; 32 in every mode built so far.
 * @property {number} ramBase      Wasm address of guest address 0.
 * @property {number} ramSize
 * @property {number} regs         8 × i32 (eax ecx edx ebx esp ebp esi edi); 16 × i64 at 64.
 * @property {number} eip
 * @property {number} previousIp
 * @property {number} eflags       The eager word (hybrid: the emulator's `flags`).
 * @property {number} flagsChanged Hybrid only, written 0 at every exit; -1 when absent.
 * @property {number} x87          8 × 16 bytes.
 * @property {'f64' | 'tagged80'} x87Format  The engine's own f64, or the emulator's tagged form.
 * @property {number} x87Top       u8.
 * @property {number} x87Empty     u8 bitmask, bit i set = register i empty.
 * @property {number} x87Control   u16.
 * @property {number} x87Status    u16.
 * @property {number} xmm          8 × 16 bytes.
 * @property {number} mxcsr
 * @property {number} fsBase       The thread block's linear address (32-bit Windows).
 * @property {number} gsBase       The same for 64-bit Windows; -1 when absent.
 * @property {number} counter      u32 retired-instruction word (hybrid: the emulator's).
 * @property {number} tables       Wasm address of the engine's own tables.
 * @property {number} codePages    Wasm address of the other executor's byte-per-page
 *                                 "has compiled code" table (hybrid), or -1: a store into
 *                                 such a page leaves `stale` so its cache can be dirtied.
 * @property {string} id           A hash of every field above.
 */

/**
 * What the layer hands an engine factory.
 *
 * @typedef {Object} EngineEnv
 * @property {WebAssembly.Memory} memory  The layer's memory (the emulator's in hybrid).
 * @property {StateLayout} layout
 * @property {EngineConfig} config
 * @property {(address: number) => number} read   One byte of guest memory.
 * @property {EngineImports} imports
 */

/**
 * The host functions translated code may call.
 *
 * @typedef {Object} EngineImports
 * @property {(id: number) => 0 | 1} trap
 *     The trap port write. Answers 1 when the handler moved EIP or asked the
 *     machine to stop, in which case the region must exit rather than continue.
 * @property {() => number} getEflags   The eager flags word, for a region that reads
 *     flags before writing them.
 * @property {(index: number) => number} x87Read  A physical x87 register the state
 *     block holds in a form the engine cannot read inline, as an f64.
 * @property {() => bigint} rdtsc
 * @property {(page: number, on: boolean) => void} [handoffPage]
 *     Hybrid: flags a page the engine holds code for, so the other executor's slice
 *     returns when the guest arrives there (`handoffPage` on the emulator's host).
 * @property {(address: number, length: number) => void} [dirtyCode]
 *     Hybrid: a store translated code made into a page the other executor compiled;
 *     the host dirties that cache.
 * @property {(physical: number) => void} [handoffHash]
 *     Hybrid: where the engine's entry hash lies in guest memory, so the other executor
 *     returns only at an address the hash holds rather than anywhere in a flagged page.
 */

/**
 * The engine's own configuration, the `cork` object of the cpu layer's.
 *
 * @typedef {Object} EngineConfig
 * @property {number} [hotThreshold]     Instructions a 64-byte bucket must have been
 *     credited before its address is a region candidate. Default 2000.
 * @property {number} [maxRegionBlocks]  Default 64.
 * @property {number} [maxRegionBytes]   Default 8192.
 * @property {number} [batchRegions]     Regions per wasm module. Default 32.
 * @property {number} [missThreshold]    Untranslated exits to one address before the engine
 *     queues it as a candidate of its own. Default 64.
 * @property {number} [trapPort]         The I/O port that is the host's call channel: a
 *     write of eax to it by translated code leaves with a `trap` exit past the instruction,
 *     and the hybrid host runs the handler the port write would have reached. Without it,
 *     the instruction is the other executor's.
 * @property {'frame' | 'slice'} [feed]  When the sampler's hot buckets become candidates:
 *     once a frame (the default, paced by presentation) or after every slice, for a run
 *     that has no frames -- a test in a process without a presenter.
 * @property {TranslationStore} [store]  The per-bundle cache; none = translate every run.
 * @property {string} [bundleId]         The cache's namespace.
 */

/**
 * Where translations are kept between runs.
 *
 * @typedef {Object} TranslationStore
 * @property {(key: string) => Promise<Uint8Array | null>} get
 * @property {(key: string, bytes: Uint8Array) => Promise<void>} put
 */

/**
 * Why a run of translated code came back, with the state block complete:
 * every register, EIP, an eager EFLAGS, the x87 block with top and empty
 * mask, XMM. Nothing is held outside the block between runs, which is what
 * makes a thread switch, a context capture and a fall back to the other
 * executor the same operation -- nothing.
 *
 * @typedef {'untranslated' | 'budget' | 'trap' | 'halt' | 'fault' | 'stale'} ExitKind
 *   untranslated  EIP in the state block has no translated entry.
 *   budget        A back-edge found the slice's budget spent; EIP is the loop header.
 *   trap          A trap handler moved EIP or asked to stop; EIP is what it set.
 *   halt          The region executed `hlt`.
 *   fault         A precise exception; EIP is the faulting instruction, registers as
 *                 before it.
 *   stale         The region was invalidated while running; EIP is the next instruction.
 */

/**
 * @typedef {Object} ExitRecord  Valid until the next `run`: the engine may hand out one
 *     record and rewrite it, so a caller that keeps an exit copies its fields.
 * @property {number} retired  Instructions retired in this run, already added to `counter`.
 * @property {ExitKind} kind
 * @property {number} vector   For `fault`: 0 (#DE), 6 (#UD), 3 (int 3), 13 (page flag);
 *                             `int n` reports n.
 */

/**
 * What an engine reports about itself, beside the layer's own figures.
 *
 * @typedef {Object} EngineDiagnostics
 * @property {number} regions          Translated and live.
 * @property {number} entries          Entry points in the hash (in the map alone, without
 *     tail calls).
 * @property {number} modules          Wasm modules instantiated.
 * @property {number} translatedShare  Instructions retired in the engine / retired, 0..1.
 * @property {number} retired          Instructions retired in the engine, for a frame's share.
 * @property {number} cacheHits        Regions taken from the store.
 * @property {number} cacheMisses
 * @property {number} invalidations    Regions discarded by a write.
 * @property {number} volatilePages    Pages written so often they are no longer translated.
 * @property {Record<ExitKind, number>} exits
 * @property {Record<string, number>} refused  Opcode ("0f 2e", "f3 0f 10") → times met.
 * @property {number} translateMs      Milliseconds spent forming, emitting and compiling.
 * @property {number} moduleBytes      Wasm bytes built this run.
 * @property {number} handoffMisses    Hybrid: slices the emulator ran through translated code.
 */

/**
 * What a runtime answers to the host that composes it.
 *
 * @typedef {Object} Runtime
 * @property {(eip: number, x87Top?: number) => number} entryOf  Function index, or -1.
 * @property {(entry: number, budget: number) => ExitRecord} run
 * @property {(eip: number, x87Top?: number) => void} noteHot  A candidate from the layer's
 *     sampler, with the x87 top a region there is compiled for.
 * @property {() => Promise<number>} translatePending
 *     Regions published; resolves when the batch is instantiated.
 * @property {(page: number) => void} invalidatePage  A host or guest write into code.
 * @property {(page: number) => boolean} holdsPage  Whether a published region spans the page
 *     (the pages the emulator's handoff bit is set for).
 * @property {() => EngineDiagnostics} diagnostics
 */

/**
 * The one export of an engine package's entry module.
 *
 * @typedef {(env: EngineEnv) => Runtime} EngineFactory
 */

/**
 * How much of the top of the guest's RAM an engine may take for its own
 * tables in hybrid mode, where the memory is the emulator's and cannot be
 * grown behind its views. The layer reports the RAM below it as the memory's
 * size to every other layer, so nothing of the guest is ever placed there.
 */
export const TABLES_RESERVE = 4 * 1024 * 1024;
