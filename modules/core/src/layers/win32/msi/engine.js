/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The installation engine's shape, apart from the actions that use it: the
 * standard actions and the custom ones each take an engine, and neither file
 * may lean on the other for what one is.
 */

/**
 * What an installation needs from outside: the volume and the registry, the
 * user interface, and running the program's own code.
 *
 * @typedef {Object} EngineHost
 * @property {any} files   The volume, as kernel32's file calls see it.
 * @property {import('./registration.js').Hive} hive
 * @property {ReturnType<typeof import('./registration.js').createRegistration>} registration
 * @property {(type: number, record: import('./record.js').Record)
 *     => number | Promise<number>} message
 *           A message for the user interface; its answer (an IDOK...) or 0.
 * @property {(session: import('./session.js').Session, deferred: string | null)
 *     => number} openHandle
 *           A handle a custom action is given; a deferred one sees only its data.
 * @property {(handle: number) => void} closeHandle
 * @property {(path: string, entry: string, args: number[]) => Promise<number | null>} callDll
 *           Loads a library, calls an export stdcall and frees it; null when it is not there.
 * @property {(path: string, entry: string, args: number[])
 *     => Promise<{ done: Promise<number | null>, stop: () => void,
 *         free: () => Promise<unknown> } | null>} startDll
 *           The same on a thread of its own, which goes on while this returns: the answer when it
 *           ends, a way to end it, and the library freed when the installation asks -- where its
 *           own thread stands still. Null when it cannot be started.
 * @property {(commandLine: string, directory: string | null, wait: boolean)
 *     => Promise<number | null>} runExe
 *           Starts a program; its exit code when waited for, null when it could not start.
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {(text: string) => void} [log]
 */

/**
 * @typedef {Object} Engine
 * @property {import('./session.js').Session} session
 * @property {unknown} thread  Whose call the installation answers, where its libraries run.
 * @property {EngineHost} host
 * @property {Set<string>} ran   Custom actions that ran, for the once-only kinds.
 * @property {boolean} executing  In the execute sequence rather than the UI one.
 * @property {{ run: () => Promise<number> }[]} commit  Commit custom actions, after the script.
 * @property {{ name: string, wait: boolean, over: boolean, done: Promise<number | null>,
 *     stop: () => void, finish?: () => Promise<unknown> }[]} async  Library actions that run
 *     beside the installation, until it is over; `finish` gives back what one held.
 */

export {};
