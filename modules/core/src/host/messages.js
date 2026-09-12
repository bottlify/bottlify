/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What crosses between a page and the worker the engine runs in.
 *
 * Typedefs only, no runtime exports: both ends import these and neither
 * imports the other, which is what keeps the protocol one thing rather than
 * two descriptions that drift.
 *
 * Three kinds go in. A request is answered, by id, with a result or a failure.
 * An input event and a visibility change are not: they are the two streams
 * that have no answer worth waiting for, and an id per pointer move is a
 * message and a map entry for nothing. Two kinds come out: the answer to a
 * request, and an event the page subscribed to (or `frame`, which is always
 * sent because the page's cursor and viewport depend on it).
 */

/**
 * What a program's run is built from, in the form that survives postMessage.
 *
 * Everything in `AppOptions` that is data crosses as it is. What does not
 * cross -- a fetch function, a GPU device, a storage provider, a watch
 * predicate -- is named here by what it is built from, and the worker builds
 * it: a bundle by its URL, a device from the worker's own `navigator.gpu`, a
 * seeded volume by its files, a watch by the libraries and ordinals it covers.
 *
 * @typedef {Omit<import('../app.js').AppOptions,
 *     'executable' | 'v86' | 'device' | 'bundle' | 'storage' | 'watchImport'
 *     | 'sample' | 'onCall' | 'pageHidden' | 'pacing'> & {
 *     executable: Uint8Array,
 *     v86: { moduleUrl: string, wasmBytes: ArrayBuffer },
 *     bundle?: { url: string, store?: string | null, id?: string, prefix?: string,
 *         prefetch?: boolean, indexSha256?: string,
 *         retry?: { attempts?: number, baseDelayMs?: number, maxDelayMs?: number } },
 *     storage?: 'opfs' | 'local' | { files: { path: string, bytes: Uint8Array }[] } | null,
 *     device?: { skipTexture?: string | null, probeTexture?: string | null,
 *         fog?: boolean, mips?: boolean, dumpDraws?: boolean, maxDraws?: number },
 *     watch?: { libraries: Record<string, number[] | null>, strings: number[] },
 *     hooks?: HookSpec[],
 *     collectOnExit?: boolean,
 *     signal?: SharedArrayBuffer,
 *     pacing?: 'page' | 'event',
 * }} StartOptions
 */

/*
 * `pacing` is how the run loop waits in a worker. `page` -- the default -- is
 * the loop a page's thread runs: a yield every turn and a short look while
 * idle. `event` sleeps until the guest's next deadline, a host answer or a
 * message, and yields only when something is pending. Measured on a real
 * title's menu through the launcher, the same build in the same worker:
 * `page` ran 1.95 G guest instructions and presented 866 frames in thirty
 * seconds, `event` 1.07 G and 469, because a host call answering woke the
 * loop for a turn that retired nothing, seventy thousand times; the page's
 * short look batches those answers. `event` stays for the measurement that
 * changes that, and is not the default until one does.
 */

/*
 * `signal` is one shared word the page adds to before every message it posts,
 * so the worker's loop can see between two turns that something is waiting
 * for it without handing its thread to the event loop to find out.
 */

/**
 * A watch in front of a routine inside a program's own module, installed the
 * moment that module is loaded. See `AppController.debug.hook`.
 *
 * @typedef {Object} HookSpec
 * @property {string} module      The module's name, lower case.
 * @property {number} offset      From the module's base.
 * @property {string} label
 * @property {number} argBytes
 * @property {number[]} lengths   Of the instructions moved to the trampoline.
 * @property {(number | string)[]} [strings]
 */

/**
 * What `start` answers with: the sound ring, if the run has one, in the shared
 * memory the page hands to its audio worklet, and who made the adapter.
 *
 * @typedef {Object} Started
 * @property {{ memory: { control: ArrayBufferLike, samples: ArrayBufferLike },
 *     sampleRate: number, channels: number } | null} audio
 * @property {{ vendor: string, architecture: string, description: string }} adapter
 */

/**
 * @typedef {Object} RequestMessage
 * @property {'request'} type
 * @property {number} id
 * @property {string} method   A key of the worker's method table.
 * @property {unknown[]} args
 */

/**
 * @typedef {Object} InputMessage
 * @property {'input'} type
 * @property {import('../layers/input/router.js').HostInputEvent} event
 */

/**
 * Whether anybody is looking. Engine pacing, not something the guest is told:
 * a hidden page's timers are clamped, and the run loop waits differently.
 *
 * @typedef {Object} VisibilityMessage
 * @property {'visibility'} type
 * @property {boolean} hidden
 */

/** @typedef {RequestMessage | InputMessage | VisibilityMessage} ToEngine */

/**
 * A failure as it travels: an Error does not carry its own properties across
 * a clone, and `reason` and `traceText` are the ones a page shows.
 *
 * @typedef {Object} Failure
 * @property {string} message
 * @property {string} [reason]
 * @property {string} [traceText]
 * @property {string} [stack]
 */

/**
 * @typedef {Object} AnswerMessage
 * @property {'answer'} type
 * @property {number} id
 * @property {unknown} [result]
 * @property {Failure} [error]
 */

/**
 * @typedef {Object} EventMessage
 * @property {'event'} type
 * @property {string} name
 * @property {unknown} payload
 */

/** @typedef {AnswerMessage | EventMessage} FromEngine */

/**
 * The one frame event: sent on the first frame and whenever the frame's size
 * changes, never per frame. The page sizes its cursor space by it.
 *
 * @typedef {Object} FramePayload
 * @property {number} width
 * @property {number} height
 * @property {number} presented   Frames shown so far, this one included.
 */

/**
 * One frame that reached the canvas, with when and how long the copy took.
 *
 * @typedef {Object} Presented
 * @property {number} index
 * @property {number} at
 * @property {number} ms
 * @property {number} w
 * @property {number} h
 * @property {boolean} failed
 */

export {};
