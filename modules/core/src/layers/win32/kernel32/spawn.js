/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Starting another program: CreateProcess, its older spelling WinExec, and the
 * pair a launcher uses to patch a child before letting it run.
 *
 * There is one address space and one emulator here, so nothing below starts a
 * second machine. A call records what was asked for -- the image, the command
 * line, the bytes to write into the child -- and the caller that assembled the
 * process replaces this one with the child once the parent has nothing left to
 * do. From the guest's side the call simply succeeds and hands back handles,
 * which is what a launcher needs to get past the point where it currently
 * cannot start at all.
 *
 * Two details in here are not decoration and are the reason this is its own
 * file rather than three entries somewhere else:
 *
 * - **argv[0] is quoted** whenever we are the one composing the child's command
 *   line. A child is handed a single string and its argv[0] ends at the first
 *   space, so an unquoted path with a space in it hands the tail of its own
 *   path to the program as an argument -- and a launcher that strips argv[0] to
 *   build its next command line then keeps that tail and re-appends it every
 *   time round, growing the line on each pass.
 * - **The image is found the way Windows finds it.** An unquoted command line
 *   is genuinely ambiguous, so each space-separated prefix is tried in turn;
 *   case is folded by the volume, which is what lets a launcher naming
 *   `game.exe` find an entry stored as `Game.exe`.
 */

/** Codes this surface reports. */
const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;

/** dwCreationFlags, the one bit that changes what a create does here. */
const CREATE_SUSPENDED = 0x00000004;

/** The pseudo-handle for the running process; -1 on every Windows. */
const CURRENT_PROCESS = 0xffffffff;

/**
 * WinExec answers above 31 on success, and with an error code below it on
 * failure. 33 is what Windows returns and carries no other meaning.
 */
const WINEXEC_SUCCESS = 33;

/** A path argument is at most this long; longer is a pointer that is not one. */
const MAX_PATH = 260;
/** And a command line, which Windows caps at the same place. */
const MAX_COMMAND_LINE = 32768;

/** sizeof(PROCESS_INFORMATION) and the offsets inside it. */
const PROCESS_INFORMATION_SIZE = 16;
const PI_PROCESS_HANDLE = 0;
const PI_THREAD_HANDLE = 4;
const PI_PROCESS_ID = 8;
const PI_THREAD_ID = 12;

/** @param {string} path */
const isQualified = path=>/^[A-Za-z]:[\\/]/.test(path) || /^[\\/]/.test(path);

/**
 * The redistributables whose job the engine already does.
 *
 * On a real machine these put side-by-side runtimes into `system32` and the
 * registry: the Visual C++ redistributable, the .NET runtime, OpenAL's
 * installer. The engine answers for those itself -- the C runtime under
 * `msvcrt` -- so there is nothing for the child to install. The request is
 * answered as a process that has run and exited 0, which is the same decision
 * already made for a shortcut.
 *
 * The DirectX End-User Runtime's `DXSETUP` is not one of them. What it
 * installs beyond the interfaces the drawing layer answers for -- the `d3dx`
 * helpers, the shader compilers -- is Microsoft's code the engine does not
 * carry, so the setup a title brings runs like any other child and puts them in
 * `system32`, where the loader finds them.
 *
 * The name is what the child is, and never the title that started it, so an
 * installer is treated the same whatever bundle it came in.
 */
const REDISTRIBUTABLE = /(^|[\\/])(vcredist[^\\/]*|vc_redist[^\\/]*|dotnetfx[^\\/]*|ndp[^\\/]*|netfx[^\\/]*|oalinst)\.exe$/i;

/**
 * @param {string} path
 * @returns {boolean}
 */
export function isRedistributableInstaller(path){
    return REDISTRIBUTABLE.test(path);
}

/** @param {string} path The directory part, separator included. */
const directoryOf = path=>path.slice(0, Math.max(
    path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1);

/**
 * @typedef {Object} SpawnerHost
 * @property {any} kernel                        The kernel layer's API.
 * @property {(path: string) => ({ exists: boolean, isDirectory: boolean } | null)} stat
 *           Whether a path names a file on the volume. Case is folded there.
 * @property {() => string} imagePath
 *           The running program, whose directory a bare name is looked for in.
 * @property {(path: string) => string} [resolve]
 *           Qualifies a path against the process's current directory, which is
 *           what makes the image a child is recorded with a full path. Without
 *           it the name the caller spelled travels on, and anything that reads a
 *           location off it -- the directory a child starts in, first of all --
 *           reads it against whoever happens to be running.
 * @property {(record: any) => void} [spawned]
 *           Told about every request as it is recorded, while the caller's
 *           stack is still standing. A replacement erases the logs of the run
 *           that asked for it, so this is where the evidence has to be taken.
 */

/**
 * @typedef {Object} Spawner
 * @property {(named: string, line: string, flags: number) => any} launch
 *           Records a child and opens the handles on it, or answers null when
 *           the image is not there. `named` is the image when the caller
 *           already knows it and '' when only the command line is there to find
 *           it in.
 * @property {(name: string) => string | null} imageOf
 *           The image a name -- or a command line whose first token is one --
 *           points at, or null.
 */

/**
 * Finding an image and recording a child for it, apart from the calls that
 * spell the request.
 *
 * kernel32's CreateProcess and WinExec are two spellings of one thing, and the
 * shell's launch is a third: all three resolve the image the same way and all
 * three hand the same record to whoever replaces this process. Which is why
 * this is here rather than inside the table below -- a shell that resolved a
 * file differently would start a different program than the one it named.
 *
 * @param {SpawnerHost} host
 * @returns {Spawner}
 */
export function createSpawner(host){
    const { kernel } = host;

    /** @param {string} path @returns {boolean} */
    const isFile = path=>{
        try
        {
            const entry = host.stat(path);
            return Boolean(entry?.exists) && !entry?.isDirectory;
        }
        catch (e){
            void e;
            return false;
        }
    };

    /**
     * The same path as a full one, or itself when there is nothing to qualify
     * it with -- no resolver, or a name the resolver refuses.
     *
     * @param {string} path
     * @returns {string}
     */
    const qualify = path=>{
        if (isQualified(path) || !host.resolve)
        {
            return path;
        }
        try
        {
            return host.resolve(path);
        }
        catch (e){
            void e;
            return path;
        }
    };

    /**
     * Where an image a program named actually lives, or null.
     *
     * A bare name is looked for beside the running program first, which is
     * where a launcher's companion executable lives and where Windows looks
     * before anything else. `.exe` is appended when the name carries no
     * extension, because CreateProcess does that too and a program that omits
     * it is not naming a different file.
     *
     * The search path is not consulted: a program that relies on one is rare,
     * and inventing an order here that Windows does not use would be worse than
     * not finding the image at all.
     *
     * The answer is a full path. A bare name is found through the current
     * directory, and a child recorded as `setup.exe` is a child whose location
     * depends on whatever directory the next program happens to start in -- its
     * own, since that is read off the image path -- which is not where the file
     * is.
     *
     * @param {string} name
     * @returns {string | null}
     */
    const resolveImage = name=>{
        const wanted = name.trim();
        if (wanted === '')
        {
            return null;
        }
        const bases = isQualified(wanted)
            ? [wanted]
            : [`${directoryOf(host.imagePath())}${wanted}`, wanted];
        const extensionless = !wanted.slice(directoryOf(wanted).length).includes('.');
        for (const base of bases)
        {
            for (const candidate of extensionless ? [base, `${base}.exe`] : [base])
            {
                if (isFile(candidate))
                {
                    return qualify(candidate);
                }
            }
        }
        return null;
    };

    /**
     * The image a command line names, when no application name was given.
     *
     * A quoted first token is the whole answer and needs no guessing. An
     * unquoted one is ambiguous -- `C:\Program Files\Setup.exe /S` could be
     * `C:\Program` with three arguments -- so each space-separated prefix is
     * tried in turn and the first that exists wins, which is the only reason an
     * unquoted path containing a space works at all.
     *
     * @param {string} line
     * @returns {string | null}
     */
    const imageFromCommandLine = line=>{
        const trimmed = line.trim();
        if (trimmed.startsWith('"'))
        {
            const end = trimmed.indexOf('"', 1);
            return end < 0 ? null : resolveImage(trimmed.slice(1, end));
        }
        const words = trimmed.split(' ').filter(word=>word.length > 0);
        for (let count = 1; count <= words.length; count++)
        {
            const found = resolveImage(words.slice(0, count).join(' '));
            if (found)
            {
                return found;
            }
        }
        return null;
    };

    return {
        launch(named, line, flags){
            const path = named === '' ? imageFromCommandLine(line) : resolveImage(named);
            if (path === null)
            {
                return null;
            }
            const made = kernel.processes.create({
                imagePath: path,
                // The caller's own line when it gave one, because that is what the
                // child is entitled to see; ours only when it did not -- and then
                // quoted, for the reason in this file's header.
                commandLine: line.trim() === '' ? `"${path}"` : line,
                suspended: (flags & CREATE_SUSPENDED) !== 0,
                // A redistributable installer is a process the engine itself
                // stands in for: it is answered as already run and exited 0, so
                // it is never what this process hands over to.
                completed: isRedistributableInstaller(path),
            });
            // Both handles name the same record, and every spelling of "start a
            // program" hands one out: a parent waits on the first and resumes
            // the second, and neither is a different object here because the
            // child has exactly one thread until it is really running.
            made.handle = kernel.handles.open('process', made);
            made.threadHandle = kernel.handles.open('process-thread', made);
            host.spawned?.(made);
            return made;
        },

        imageOf: name=>resolveImage(name) ?? imageFromCommandLine(name),
    };
}

/**
 * @typedef {Object} SpawnHost
 * @property {any} kernel                        The kernel layer's API.
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {(code: number) => void} setLastError
 * @property {(path: string) => ({ exists: boolean, isDirectory: boolean } | null)} stat
 *           Whether a path names a file on the volume. Case is folded there.
 * @property {(path: string) => string} [resolve]
 *           Qualifies a path against the process's current directory, for the
 *           spawner this builds when it was not handed one.
 * @property {() => string} imagePath
 *           The running program, whose directory a bare name is looked for in.
 * @property {(record: any) => void} [spawned]
 *           Told about every request as it is recorded, while the caller's
 *           stack is still standing. A replacement erases the logs of the run
 *           that asked for it, so this is where the evidence has to be taken.
 * @property {Spawner} [spawner]
 *           The one every library in this process launches through, when the
 *           caller assembled it. Built here otherwise, from the same fields.
 * @property {number} [processId]  The running program's own identifier.
 */

/**
 * @param {SpawnHost} host
 */
export function createSpawnFunctions(host){
    const { kernel } = host;
    const record = (host.spawner ?? createSpawner(host)).launch;

    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        host.writeMemory(address, new Uint8Array([
            value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
        ]));
    };

    /** @param {number} handle @returns {any} */
    const processOf = handle=>{
        try
        {
            return kernel.handles.resolve(handle >>> 0, 'process');
        }
        catch (e){
            void e;
            return null;
        }
    };

    /**
     * @param {string} named @param {string} line
     * @param {number} flags @param {number} information
     */
    const create = (named, line, flags, information)=>{
        const made = record(named, line, flags);
        if (!made)
        {
            host.setLastError(ERROR_FILE_NOT_FOUND);
            return 0;
        }
        if ((information >>> 0) !== 0)
        {
            const bytes = new Uint8Array(PROCESS_INFORMATION_SIZE);
            host.writeMemory(information >>> 0, bytes);
            writeDword((information >>> 0) + PI_PROCESS_HANDLE, made.handle);
            writeDword((information >>> 0) + PI_THREAD_HANDLE, made.threadHandle);
            writeDword((information >>> 0) + PI_PROCESS_ID, made.id);
            writeDword((information >>> 0) + PI_THREAD_ID, made.threadId);
        }
        host.setLastError(ERROR_SUCCESS);
        return 1;
    };

    return {
        /**
         * BOOL CreateProcessA(LPCSTR lpApplicationName, LPSTR lpCommandLine,
         *   LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES, BOOL bInheritHandles,
         *   DWORD dwCreationFlags, LPVOID lpEnvironment, LPCSTR lpCurrentDirectory,
         *   LPSTARTUPINFOA lpStartupInfo, LPPROCESS_INFORMATION lpProcessInformation)
         *
         * The handles are real and the ids are the child's; what does not exist
         * yet is the child itself. Inherited handles, a chosen environment and a
         * chosen current directory are accepted and not acted on -- the child
         * runs in this machine's own volume and environment, which is the same
         * one the parent had.
         */
        CreateProcessA: {
            argBytes: 40,
            /** @param {number[]} args */
            handler: ([application, commandLine, , , , flags, , , , information])=>create(
                (application >>> 0) === 0 ? '' : host.readCString(application >>> 0, MAX_PATH),
                (commandLine >>> 0) === 0
                    ? ''
                    : host.readCString(commandLine >>> 0, MAX_COMMAND_LINE),
                flags >>> 0, information),
        },

        /** BOOL CreateProcessW(...) — the same call, read as wide strings. */
        CreateProcessW: {
            argBytes: 40,
            /** @param {number[]} args */
            handler: ([application, commandLine, , , , flags, , , , information])=>create(
                (application >>> 0) === 0 ? ''
                    : host.readWideString(application >>> 0, MAX_PATH * 2),
                (commandLine >>> 0) === 0
                    ? ''
                    : host.readWideString(commandLine >>> 0, MAX_COMMAND_LINE * 2),
                flags >>> 0, information),
        },

        /**
         * HANDLE OpenProcess(DWORD dwDesiredAccess, BOOL bInheritHandle, DWORD dwProcessId)
         *
         * The processes there are: the running program, and the children it
         * asked for. Any access is granted -- there is one user -- and an
         * identifier that names nothing is the documented invalid parameter.
         * The program's own process comes back as the pseudo-handle every
         * other call here already understands as "this process".
         */
        OpenProcess: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, , id])=>{
                const wanted = id >>> 0;
                // The same default GetCurrentProcessId falls back to.
                if (wanted === ((host.processId ?? 0x1000) >>> 0))
                {
                    return CURRENT_PROCESS;
                }
                const child = kernel.processes.all().find(
                    (/** @type {any} */ made)=>made.id === wanted);
                if (!child)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                return kernel.handles.open('process', child);
            },
        },

        /**
         * UINT WinExec(LPCSTR lpCmdLine, UINT uCmdShow)
         *
         * The 16-bit spelling, and still what a self-extracting installer stub
         * uses to start the installer it just unpacked. It hands back no handle
         * and does not wait, so there is nothing for the caller to do afterwards
         * but exit -- which is exactly the sequence a replacement serves.
         *
         * uCmdShow is ignored: how a window is first shown is the child's own
         * business once it creates one.
         */
        WinExec: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([commandLine])=>{
                const line = (commandLine >>> 0) === 0
                    ? ''
                    : host.readCString(commandLine >>> 0, MAX_COMMAND_LINE);
                if (!record('', line, 0))
                {
                    host.setLastError(ERROR_FILE_NOT_FOUND);
                    return ERROR_FILE_NOT_FOUND;
                }
                host.setLastError(ERROR_SUCCESS);
                return WINEXEC_SUCCESS;
            },
        },

        /**
         * BOOL WriteProcessMemory(HANDLE hProcess, LPVOID lpBaseAddress,
         *   LPCVOID lpBuffer, SIZE_T nSize, SIZE_T *lpNumberOfBytesWritten)
         *
         * Against the running process this writes memory. Against a child it
         * cannot, because the child's image is not mapped -- so the write is
         * kept as a patch and replayed at the address it names once the PE is
         * there. That is what makes CREATE_SUSPENDED, a write, and ResumeThread
         * work without a second address space ever existing.
         *
         * The bytes are copied out rather than kept as a view: the machine they
         * came from is torn down before they are used.
         */
        WriteProcessMemory: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, base, buffer, size, written])=>{
                const count = size >>> 0;
                const bytes = count === 0
                    ? new Uint8Array(0)
                    : host.readMemory(buffer >>> 0, count).slice();

                if ((handle >>> 0) === CURRENT_PROCESS)
                {
                    host.writeMemory(base >>> 0, bytes);
                }
                else
                {
                    const target = processOf(handle);
                    if (!target)
                    {
                        host.setLastError(ERROR_INVALID_HANDLE);
                        return 0;
                    }
                    target.patches.push({ address: base >>> 0, bytes });
                }

                if ((written >>> 0) !== 0)
                {
                    writeDword(written >>> 0, count);
                }
                host.setLastError(ERROR_SUCCESS);
                return 1;
            },
        },
    };
}
