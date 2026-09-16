/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * filesystem layer -- the volume a Win32 program sees.
 *
 * Responsibilities (master plan section 9): Windows path semantics, a
 * copy-on-write overlay of a writable layer over a read-only source, open
 * files, and later the user layer as a session and its synchronisation.
 * Requires: log.
 *
 * What this layer is not: it is not the Win32 file API. It reports failures by
 * name (`internal/errors.js`) and returns handle objects rather than numbers,
 * because which error number an API answers with, and what a HANDLE is worth,
 * are decisions belonging to the caller implementing that API.
 *
 * Configuration:
 *
 * ```js
 * {
 *     drives: {
 *         C: {
 *             source: SourceStore | null,
 *             system: SourceStore | null,
 *             writable: WritableStore,
 *         },
 *     },
 *     system: SourceStore | null,
 *     openFileLimit: 4096,
 * }
 * ```
 *
 * `system` is the engine's own read-only volume, mounted beneath every bundle;
 * `source` wins where both name a path, and a write to a file only `system`
 * holds is `ACCESS_DENIED`.
 *
 * Both stores are injected; nothing here reaches for a browser API. With no
 * configuration the layer mounts `C:` on an in-memory writable store, which is
 * a complete volume for as long as the process lives. The store contracts are
 * `SourceStore` and `WritableStore` in `internal/memory-store.js`, which also
 * holds the implementation of the second one.
 *
 * The API a consumer sees:
 *
 * - `mount(letter, { source, system, writable })`, `drives()`
 * - `resolve(path)`, `currentDirectory()`, `setCurrentDirectory(path)`
 * - `stat(path)`, `list(path, pattern?)`
 * - `createDirectory(path)`, `removeDirectory(path)`, `deleteFile(path)`
 * - `open(path, { read, write, shareRead, shareWrite, disposition })`
 * - `read(handle, length)`, `write(handle, bytes)`, `seek(handle, offset, from)`,
 *   `position(handle)`, `size(handle)`, `setEndOfFile(handle)`, `close(handle)`
 * - the `ErrorCode`, `Disposition` and `SeekFrom` vocabularies
 *
 * A path that names a reserved device (CON, NUL, COM1 and the rest) is not a
 * file and is never opened as one: every call that would touch the volume
 * fails with `IS_DEVICE`, carrying the device's name. `resolve` reports it
 * without failing, so a caller can route the call before making it.
 *
 * @typedef {import("../../system/contract.js").ModuleConfig} Config
 */
