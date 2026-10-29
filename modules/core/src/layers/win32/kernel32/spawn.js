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
 *   line, and when the caller named the image with a space in it and no
 *   quotes, as CreateProcess quotes it. A child is handed a single string
 *   and its argv[0] ends at the first space, so an unquoted path with a
 *   space in it hands the tail of its own path to the program as an argument
 *   -- and a launcher that strips argv[0] to build its next command line then
 *   keeps that tail and re-appends it every time round, growing the line on
 *   each pass.
 * - **The image is found the way Windows finds it.** An unquoted command line
 *   is genuinely ambiguous, so each space-separated prefix is tried in turn;
 *   case is folded by the volume, which is what lets a launcher naming
 *   `game.exe` find an entry stored as `Game.exe`.
 */

import { SYSTEM_DIRECTORY, systemProgramAt } from '../programs/table.js';
import { decodeAnsi, encodeAnsi } from './locale.js';
import { STARTUPINFO, readStartupInfo } from './startup-info.js';
import { askChild, childThread } from './cross-process.js';

/** Codes this surface reports. */
const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_INVALID_HANDLE = 6;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_PARAMETER = 87;
/** ReadProcessMemory of a range nothing is at. */
const ERROR_PARTIAL_COPY = 299;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_BAD_LENGTH = 24;
const ERROR_NOT_SUPPORTED = 50;
const ERROR_GEN_FAILURE = 31;
const ERROR_OBJECT_NAME_EXISTS = 5010;
const ERROR_NOACCESS = 998;
/** QueryFullProcessImageName's one flag: the path in the object manager's terms. */
const PROCESS_NAME_NATIVE = 1;
/** CreateProcess's flag saying the environment block is UTF-16. */
const CREATE_UNICODE_ENVIRONMENT = 0x400;
/** The most of an environment block read: a block runs to two NULs well before. */
const ENVIRONMENT_LIMIT = 0x10000;

/**
 * Writes into this process's memory as WriteProcessMemory writes into its
 * own: through the protection of the pages, which it lifts for the write and
 * puts back -- a heap library patching the C runtime's malloc writes a jump
 * over code that is only executable. Only what lies in one mapped region is
 * written; anything else answers false and nothing.
 *
 * @param {{ find: (address: number) => { name: string, base: number, size: number,
 *     access: string } | undefined | null, protect: (name: string, access: string) => void,
 *     writeBytes: (address: number, bytes: Uint8Array) => void }} memory
 * @param {number} address
 * @param {Uint8Array} bytes
 */
export function writeThroughProtection(memory, address, bytes){
    const region = memory.find(address);
    if (!region || address + bytes.length > region.base + region.size)
    {
        return false;
    }
    const access = region.access;
    const lifted = access.includes('w') ? null : access.includes('x') ? 'rwx' : 'rw';
    if (lifted)
    {
        memory.protect(region.name, lifted);
    }
    try
    {
        memory.writeBytes(address, bytes);
    }
    finally
    {
        if (lifted)
        {
            memory.protect(region.name, access);
        }
    }
    return true;
}

/** A PROC_THREAD_ATTRIBUTE_LIST's header and each attribute after it, in bytes. */
const ATTRIBUTE_LIST_HEADER = 20;
const ATTRIBUTE_ENTRY = 12;
/** The attribute that names the handles a child inherits, and none else. */
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x20002;
/** CreateProcess's flag: the STARTUPINFO is a STARTUPINFOEX, its attribute list behind it. */
const EXTENDED_STARTUPINFO_PRESENT = 0x80000;
/**
 * The attributes a list takes, each with the sizes its value may have: the
 * parent process and a pseudo-console are a handle, a handle or job list
 * whole handles, the ideal processor a PROCESSOR_NUMBER, group affinity a
 * GROUP_AFFINITY, a mitigation policy a DWORD or a DWORD64, the machine type
 * a USHORT.
 *
 * @type {Map<number, (size: number) => boolean>}
 */
const ATTRIBUTE_SIZES = new Map([
    [0x00020000, size=>size === 4],
    [0x00020002, size=>size % 4 === 0],
    [0x00030005, size=>size === 4],
    [0x00030003, size=>size === 12],
    [0x00020007, size=>size === 4 || size === 8],
    [0x0002000d, size=>size % 4 === 0],
    [0x00020016, size=>size === 4],
    [0x00020019, size=>size === 2],
]);

/** dwCreationFlags, the one bit that changes what a create does here. */
const CREATE_SUSPENDED = 0x00000004;
const DEBUG_PROCESS = 0x00000001;
/** The session an interactive user's processes run in. */
const INTERACTIVE_SESSION = 1;
const DEBUG_ONLY_THIS_PROCESS = 0x00000002;

/** STARTUPINFO's dwFlags bit that says its three handles are the child's own. */
const STARTF_USESTDHANDLES = 0x00000100;
/**
 * Where dwFlags, hStdOutput and hStdError sit in STARTUPINFOA and W alike;
 * in a 64-bit process, whose three strings and four handles are eight bytes.
 */
const STARTUP = Object.freeze({ flags: 44, output: 60, error: 64 });
const STARTUP64 = Object.freeze({ flags: 60, output: 88, error: 96 });

/** The pseudo-handle for the running process; -1 on every Windows. */
const CURRENT_PROCESS = 0xffffffff;

/**
 * WinExec answers above 31 on success, and with an error code below it on
 * failure. 33 is what Windows returns and carries no other meaning.
 */
const WINEXEC_SUCCESS = 33;

/** A path argument is at most this long; longer is a pointer that is not one. */
/**
 * A path is read to its terminator, as Windows reads it: one cut at MAX_PATH
 * names another program or directory.
 */
const WHOLE_NAME = 32767;
/** And a command line, which Windows caps at the same place. */
const MAX_COMMAND_LINE = 32768;

/** PROCESS_INFORMATION, and in a 64-bit process, whose two handles are eight bytes. */
const PROCESS_INFORMATION = Object.freeze({ process: 0, thread: 4, processId: 8, threadId: 12,
    SIZE: 16 });
const PROCESS_INFORMATION64 = Object.freeze({ process: 0, thread: 8, processId: 16,
    threadId: 20, SIZE: 24 });

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

/**
 * Where CreateProcess looks for a bare name after the program's own directory
 * and the current one, in its documented order: the system directory, the
 * 16-bit system directory, the Windows directory.
 */
const SYSTEM_SEARCH = [SYSTEM_DIRECTORY, 'C:\\WINDOWS\\system', 'C:\\WINDOWS'];

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
 * @property {() => string} [currentDirectory]
 *           The process's current directory, which a system program it starts
 *           begins in.
 */

/**
 * @typedef {Object} Spawner
 * @property {(named: string, line: string, flags: number, directory?: string,
 *     handed?: Record<string, any>) => any} launch
 *           Records a child and opens the handles on it, or answers null when
 *           the image is not there. `named` is the image when the caller
 *           already knows it and '' when only the command line is there to find
 *           it in. `directory` is the one the caller asked the child to start
 *           in, '' for none.
 * @property {(name: string) => string | null} imageOf
 *           The image a name -- or a command line whose first token is one --
 *           points at, or null.
 */

/**
 * The error CreateProcess answers before it looks for any file, or 0 when the
 * names are well formed. An application name given as an empty string names
 * no path; with none given, the image is the command line's first token, and
 * a line that is empty or starts with a blank, or whose quoted name is empty
 * once its trailing spaces go, names none (Wine's kernel32 test_CommandLine
 * records what Windows answers to each).
 *
 * @param {string | null} named  lpApplicationName, null for NULL.
 * @param {string} line
 */
export function createRefusal(named, line){
    if (named !== null)
    {
        return named === '' ? ERROR_PATH_NOT_FOUND : 0;
    }
    if (line === '' || line[0] === ' ' || line[0] === '\t')
    {
        return ERROR_INVALID_PARAMETER;
    }
    if (line[0] === '"')
    {
        const end = line.indexOf('"', 1);
        const name = line.slice(1, end < 0 ? line.length : end);
        return name.replace(/ +$/, '') === '' ? ERROR_INVALID_PARAMETER : 0;
    }
    return 0;
}

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
     * Whether a path is an image: a file on the volume, or one of the system
     * programs the engine provides (`programs/table.js`) where the volume has
     * none.
     *
     * @param {string} path
     */
    const isImage = path=>isFile(path) || systemProgramAt(path) !== null;

    /**
     * Where an image a program named actually lives, or null.
     *
     * A bare name is looked for beside the running program first, which is
     * where a launcher's companion executable lives and where Windows looks
     * before anything else; then in the current directory, and then in the
     * system directories and the Windows directory, as CreateProcess
     * documents. `.exe` is appended when the name carries no extension,
     * because CreateProcess does that too and a program that omits it is not
     * naming a different file.
     *
     * The PATH is not consulted: a program that relies on it is rare, and
     * what it holds is the machine's, not the program's.
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
        // Trailing spaces only: a name that begins with blanks names no file,
        // and CreateProcess looks for it as spelled (`createRefusal`).
        const wanted = name.replace(/ +$/, '');
        if (wanted === '')
        {
            return null;
        }
        const bare = !/[\\/]/.test(wanted);
        const bases = isQualified(wanted)
            ? [wanted]
            : [`${directoryOf(host.imagePath())}${wanted}`, wanted,
                ...bare ? SYSTEM_SEARCH.map(directory=>`${directory}\\${wanted}`) : []];
        const extensionless = !wanted.slice(directoryOf(wanted).length).includes('.');
        for (const base of bases)
        {
            for (const candidate of extensionless ? [base, `${base}.exe`] : [base])
            {
                if (isImage(candidate))
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
     * When the name that won has a space in it, the child's line is the
     * caller's with that name put in quotes, as CreateProcess itself does: the
     * child's C runtime ends argv[0] -- and starts WinMain's lpCmdLine -- at the
     * first unquoted space, so the caller's own spelling would hand the child
     * the tail of its own path as an argument.
     *
     * @param {string} line
     * @returns {{ path: string, line: string } | null}
     */
    const imageFromCommandLine = line=>{
        const trimmed = line.trim();
        if (trimmed.startsWith('"'))
        {
            const end = trimmed.indexOf('"', 1);
            const path = end < 0 ? null : resolveImage(trimmed.slice(1, end));
            return path === null ? null : { path, line };
        }
        const words = trimmed.split(' ');
        for (let count = 1; count <= words.length; count++)
        {
            if (words[count - 1].length === 0)
            {
                continue;
            }
            const name = words.slice(0, count).join(' ');
            const path = resolveImage(name);
            if (path)
            {
                return {
                    path,
                    line: name.includes(' ') ? `"${name}"${trimmed.slice(name.length)}` : line,
                };
            }
        }
        return null;
    };

    return {
        launch(named, line, flags, directory = '', handed = {}){
            const found = named === ''
                ? imageFromCommandLine(line)
                : { path: resolveImage(named), line };
            if (found === null || found.path === null)
            {
                return null;
            }
            const path = found.path;
            const childLine = found.line;
            const made = kernel.processes.create({
                imagePath: path,
                // The caller's own line when it gave one, because that is what the
                // child is entitled to see; ours only when it did not -- and then
                // quoted, for the reason in this file's header.
                commandLine: childLine.trim() === '' ? `"${path}"` : childLine,
                suspended: (flags & CREATE_SUSPENDED) !== 0,
                // A redistributable installer is a process the engine itself
                // stands in for: it is answered as already run and exited 0, so
                // it is never what this process hands over to.
                completed: isRedistributableInstaller(path),
            });
            // Every spelling of "start a program" hands both out: a parent
            // waits on the process and resumes, suspends or reads the thread,
            // which is the child's first, reached where the child runs.
            made.handle = kernel.handles.open('process', made);
            made.threadHandle = kernel.handles.open('process-thread',
                childThread(made, made.threadId));
            // A child its parent debugs reports its creation and its exit to
            // WaitForDebugEvent.
            made.debugEvents = (flags & (DEBUG_PROCESS | DEBUG_ONLY_THIS_PROCESS)) !== 0
                ? ['create', 'exit'] : null;
            // A child starts in its own image's directory here; a system
            // program has nothing of its own there, and the paths on its
            // command line are its parent's to mean -- `msiexec /i setup.msi`
            // -- so it starts where Windows starts every child: in the
            // directory asked for, else in its parent's current one.
            if (!isFile(path) && systemProgramAt(path) !== null)
            {
                made.startDirectory = directory.trim() !== '' ? qualify(directory.trim())
                    : host.currentDirectory?.();
            }
            // What the caller hands the child -- its STARTUPINFO, environment
            // and parent -- is on the record before anyone is told of it: the
            // child is built from it the moment it is.
            Object.assign(made, handed);
            host.spawned?.(made);
            return made;
        },

        imageOf: name=>resolveImage(name) ?? imageFromCommandLine(name)?.path ?? null,
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
 * @property {() => string} [currentDirectory]
 *           The process's current directory, for the spawner this builds.
 * @property {Spawner} [spawner]
 *           The one every library in this process launches through, when the
 *           caller assembled it. Built here otherwise, from the same fields.
 * @property {number} [processId]  The running program's own identifier.
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {(path: string) => string | null} [nativePath]  A path as the object
 *           manager names it, `\\Device\\HarddiskVolume1\\...`; null where it has no
 *           drive.
 * @property {() => import('./startup-info.js').StartupRecord | null} [startup]
 *           This process's own, whose desktop a child named none of inherits.
 * @property {import('./cross-process.js').AskHost['askChild']} [askChild]
 *           A call made in a child where it runs; absent, no child is reached.
 * @property {() => any} [currentThread]
 * @property {(thread: any, code: number) => void} [setLastErrorFor]
 * @property {(only: number[] | null) => { handle: number, type: string, object: any }[]}
 *     [inheritedHandles]  The handles a child started with bInheritHandles takes:
 *     every inheritable one, or of those the ones a handle list names.
 * @property {() => Record<string, string>} [environment]
 *           This process's variables as they are now, which a child given no
 *           block inherits.
 * @property {(address: number, bytes: Uint8Array) => boolean} [patchMemory]
 *           Writes into this process through the pages' protection
 *           (`writeThroughProtection`); false when not all of it is mapped.
 * @property {number} [pointerSize]  8 in a 64-bit process, whose STARTUPINFO and
 *           PROCESS_INFORMATION hold eight-byte handles; absent, 4.
 */

/**
 * @param {SpawnHost} host
 */
export function createSpawnFunctions(host){
    const { kernel } = host;
    const record = (host.spawner ?? createSpawner(host)).launch;
    const STARTUP_ = host.pointerSize === 8 ? STARTUP64 : STARTUP;
    const INFORMATION = host.pointerSize === 8 ? PROCESS_INFORMATION64 : PROCESS_INFORMATION;

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
     * A call made in the child a handle names, where it runs
     * (`cross-process.js`): ERROR_INVALID_HANDLE for a handle that names no
     * child, ERROR_ACCESS_DENIED for one the run cannot reach.
     *
     * @param {number} handle @param {import('./cross-process.js').CrossCall} call
     * @param {(number | null)[]} into
     */
    const inChild = (handle, call, into)=>{
        const target = processOf(handle);
        if (!target)
        {
            host.setLastError(ERROR_INVALID_HANDLE);
            return 0;
        }
        const asked = host.currentThread && host.setLastErrorFor ? askChild({
            askChild: host.askChild, writeMemory: host.writeMemory,
            currentThread: host.currentThread, setLastErrorFor: host.setLastErrorFor,
        }, target, call, into) : null;
        if (asked === null)
        {
            host.setLastError(ERROR_ACCESS_DENIED);
            return 0;
        }
        return asked;
    };

    /** @param {number} address */
    const readDword = address=>{
        const b = host.readMemory(address, 4);
        return (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0;
    };

    /**
     * An environment block as variables: NAME=VALUE entries, each ended by a
     * NUL and the block by another, ANSI unless CREATE_UNICODE_ENVIRONMENT
     * says UTF-16 -- whichever CreateProcess was called. A name may begin
     * with '=', as the per-drive directories' do; the value starts at the
     * first '=' after it.
     *
     * @param {number} address @param {boolean} wide
     * @returns {Record<string, string>}
     */
    const environmentBlock = (address, wide)=>{
        const unit = wide ? 2 : 1;
        /** @type {Record<string, string>} */
        const variables = {};
        let entry = '';
        for (let at = address; at < address + ENVIRONMENT_LIMIT; at += unit)
        {
            const bytes = host.readMemory(at, unit);
            const code = wide ? bytes[0] | bytes[1] << 8 : bytes[0];
            if (code !== 0)
            {
                entry += wide ? String.fromCharCode(code) : decodeAnsi(bytes.subarray(0, 1));
                continue;
            }
            if (entry === '')
            {
                break;
            }
            const cut = entry.indexOf('=', 1);
            if (cut > 0)
            {
                variables[entry.slice(0, cut)] = entry.slice(cut + 1);
            }
            entry = '';
        }
        return variables;
    };

    /**
     * The image a process handle names: this process's, or a child's.
     *
     * @param {number} handle @returns {string | null}
     */
    const imagePathOf = handle=>((handle >>> 0) === CURRENT_PROCESS ? host.imagePath()
        : processOf(handle)?.imagePath ?? null);

    /**
     * QueryFullProcessImageName in either width. The size is the room in
     * characters going in and the length without its terminator coming out;
     * a buffer too small for the path and its terminator leaves both the
     * buffer and the size as they were (Wine's test_QueryFullProcessImageName).
     * The native form names the volume as the object manager does, as the
     * drives say; without them it is refused, and said so.
     *
     * @param {boolean} wide
     */
    const queryImageName = wide=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: ([handle, flags, buffer, size])=>{
            const named = imagePathOf(handle);
            if (named === null)
            {
                host.setLastError(ERROR_INVALID_HANDLE);
                return 0;
            }
            if ((flags >>> 0) & ~PROCESS_NAME_NATIVE)
            {
                host.setLastError(ERROR_INVALID_PARAMETER);
                return 0;
            }
            const native = (flags >>> 0) === PROCESS_NAME_NATIVE;
            const path = native ? host.nativePath?.(named) ?? null : named;
            if (path === null)
            {
                host.divergence?.('QueryFullProcessImageName', 'the native path is not answered');
                host.setLastError(ERROR_NOT_SUPPORTED);
                return 0;
            }
            const room = readDword(size >>> 0);
            if (room < path.length + 1)
            {
                host.setLastError(ERROR_INSUFFICIENT_BUFFER);
                return 0;
            }
            if ((buffer >>> 0) === 0)
            {
                host.setLastError(ERROR_INVALID_PARAMETER);
                return 0;
            }
            const text = `${path}\0`;
            if (wide)
            {
                const bytes = new Uint8Array(text.length * 2);
                for (let i = 0; i < text.length; i++)
                {
                    bytes[i * 2] = text.charCodeAt(i) & 0xff;
                    bytes[i * 2 + 1] = text.charCodeAt(i) >>> 8;
                }
                host.writeMemory(buffer >>> 0, bytes);
            }
            else
            {
                host.writeMemory(buffer >>> 0, encodeAnsi(text));
            }
            writeDword(size >>> 0, path.length);
            return 1;
        },
    });

    /**
     * The files a STARTUPINFO hands the child as its output and error, when
     * it hands any: a handle the parent inherits shares one file position
     * with the child's, so each names the parent's own open file, whose
     * position the child's writes move. A handle that is not a file -- the
     * console, a pipe -- leaves that stream where it was.
     *
     * @param {number} startup
     * @returns {{ output?: any, error?: any } | undefined}
     */
    const standardFiles = startup=>{
        if (startup === 0 || (readDword(startup + STARTUP_.flags) & STARTF_USESTDHANDLES) === 0)
        {
            return undefined;
        }
        /** @param {number} handle */
        const fileOf = handle=>{
            try
            {
                const file = kernel.handles.resolve(handle, 'file');
                return file?.path && file.write ? file : undefined;
            }
            catch (e){
                void e;
                return undefined;
            }
        };
        return {
            output: fileOf(readDword(startup + STARTUP_.output)),
            error: fileOf(readDword(startup + STARTUP_.error)),
        };
    };

    /**
     * The handles a STARTUPINFOEX's PROC_THREAD_ATTRIBUTE_HANDLE_LIST names,
     * or null where none does: then every inheritable handle is inherited.
     *
     * @param {number} startup @param {number} flags
     * @returns {number[] | null}
     */
    const handleList = (startup, flags)=>{
        if (startup === 0 || (flags & EXTENDED_STARTUPINFO_PRESENT) === 0)
        {
            return null;
        }
        const list = readDword(startup + STARTUPINFO.SIZE);
        if (list === 0)
        {
            return null;
        }
        const used = readDword(list + 8);
        for (let at = 0; at < used; at++)
        {
            const entry = list + ATTRIBUTE_LIST_HEADER + at * ATTRIBUTE_ENTRY;
            if (readDword(entry) === PROC_THREAD_ATTRIBUTE_HANDLE_LIST)
            {
                const value = readDword(entry + 8);
                return Array.from({ length: readDword(entry + 4) >>> 2 },
                    (_, index)=>readDword(value + index * 4));
            }
        }
        return null;
    };

    /**
     * @param {string | null} named  null where no application name was given.
     * @param {string} line
     * @param {number} flags @param {number} information @param {number} [startup]
     * @param {string} [directory]
     * @param {boolean} [wide]  CreateProcessW's, whose STARTUPINFO's strings are wide.
     * @param {number} [environment]  lpEnvironment.
     * @param {boolean} [inherit]  bInheritHandles.
     */
    const create = (named, line, flags, information, startup = 0, directory = '', wide = false,
        environment = 0, inherit = false)=>
    {
        // Cleared first: a call that fails leaves no handle or id in it.
        if ((information >>> 0) !== 0)
        {
            host.writeMemory(information >>> 0, new Uint8Array(INFORMATION.SIZE));
        }
        const refused = createRefusal(named, line);
        if (refused !== 0)
        {
            host.setLastError(refused);
            return 0;
        }
        const made = record(named ?? '', line, flags, directory, {
            standardFiles: standardFiles(startup >>> 0),
            // What the child's GetStartupInfo answers: values, since the child
            // may be built on another thread from what crosses to it.
            startup: (startup >>> 0) === 0 ? null : readStartupInfo(
                host.readMemory(startup >>> 0, STARTUPINFO.SIZE),
                address=>(wide ? host.readWideString(address, WHOLE_NAME * 2)
                    : host.readCString(address, WHOLE_NAME)),
                host.startup?.()?.desktop ?? null),
            // The process that started it, which its own snapshot names.
            parentId: (host.processId ?? 0) >>> 0,
            // The block asked for, or this process's variables as they are now.
            environment: (environment >>> 0) === 0 ? host.environment?.() ?? null
                : environmentBlock(environment >>> 0, (flags & CREATE_UNICODE_ENVIRONMENT) !== 0),
            // The handles it inherits, under the numbers this process has
            // them by: the pipes' ends, which every process of the run on this
            // thread holds alike. A child in a worker of its own takes none.
            inheritedHandles: inherit && host.inheritedHandles
                ? host.inheritedHandles(handleList(startup >>> 0, flags)) : [],
        });
        if (!made)
        {
            host.setLastError(ERROR_FILE_NOT_FOUND);
            return 0;
        }
        if ((information >>> 0) !== 0)
        {
            writeDword((information >>> 0) + INFORMATION.process, made.handle);
            writeDword((information >>> 0) + INFORMATION.thread, made.threadHandle);
            writeDword((information >>> 0) + INFORMATION.processId, made.id);
            writeDword((information >>> 0) + INFORMATION.threadId, made.threadId);
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
         * yet is the child itself. A STARTUPINFO's output and error files are the
         * child's own; other inherited handles and a chosen environment are
         * accepted and not acted on -- the child runs in this machine's own
         * volume and environment, which is the same one the parent had. A
         * chosen current directory is where a system program starts
         * (`createSpawner`); any other child starts in its own directory.
         */
        CreateProcessA: {
            argBytes: 40,
            /** @param {number[]} args */
            handler: ([application, commandLine, , , inherit, flags, environment, directory,
                startup, information])=>create(
                (application >>> 0) === 0 ? null : host.readCString(application >>> 0, WHOLE_NAME),
                (commandLine >>> 0) === 0
                    ? ''
                    : host.readCString(commandLine >>> 0, MAX_COMMAND_LINE),
                flags >>> 0, information, startup,
                (directory >>> 0) === 0 ? '' : host.readCString(directory >>> 0, WHOLE_NAME),
                false, environment, inherit !== 0),
        },

        /** BOOL CreateProcessW(...) — the same call, read as wide strings. */
        CreateProcessW: {
            argBytes: 40,
            /** @param {number[]} args */
            handler: ([application, commandLine, , , inherit, flags, environment, directory,
                startup, information])=>create(
                (application >>> 0) === 0 ? null
                    : host.readWideString(application >>> 0, WHOLE_NAME * 2),
                (commandLine >>> 0) === 0
                    ? ''
                    : host.readWideString(commandLine >>> 0, MAX_COMMAND_LINE * 2),
                flags >>> 0, information, startup,
                (directory >>> 0) === 0 ? '' : host.readWideString(directory >>> 0, WHOLE_NAME * 2),
                true, environment, inherit !== 0),
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
                    // A real handle, never the pseudo-handle: a browser opens
                    // itself to hand the handle to a child it starts, and in
                    // the child (HANDLE)-1 would be the child. The record its
                    // parent holds is the one every process waits on; a
                    // process nobody started has none, and its own handle is
                    // the pseudo-handle's object.
                    const self = kernel.processes.find?.(wanted)
                        ?? { kind: 'process', current: true, imagePath: host.imagePath?.() ?? '' };
                    return kernel.handles.open('process', self);
                }
                // A child, or any process of the run on this thread: a crash
                // reporter opens the client that asked it for a dump.
                const child = kernel.processes.find?.(wanted) ?? kernel.processes.all().find(
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
         * BOOL InitializeProcThreadAttributeList(LPPROC_THREAD_ATTRIBUTE_LIST,
         *     DWORD dwAttributeCount, DWORD dwFlags, PSIZE_T lpSize)
         *
         * The list's header -- mask, room, count, a word of padding never
         * written, a word kept zero -- then twelve bytes an attribute: its
         * number, its size and where its value is. With too little room, or
         * no list, the size it needs.
         */
        InitializeProcThreadAttributeList: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([list, count, flags, size])=>{
                if ((flags >>> 0) !== 0 || (size >>> 0) === 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const needed = ATTRIBUTE_LIST_HEADER + (count >>> 0) * ATTRIBUTE_ENTRY;
                const room = readDword(size >>> 0);
                writeDword(size >>> 0, needed);
                if ((list >>> 0) === 0 || room < needed)
                {
                    host.setLastError(ERROR_INSUFFICIENT_BUFFER);
                    return 0;
                }
                writeDword(list >>> 0, 0);
                writeDword((list >>> 0) + 4, count >>> 0);
                writeDword((list >>> 0) + 8, 0);
                writeDword((list >>> 0) + 16, 0);
                return 1;
            },
        },

        /**
         * BOOL UpdateProcThreadAttribute(LPPROC_THREAD_ATTRIBUTE_LIST, DWORD dwFlags,
         *     DWORD_PTR Attribute, PVOID lpValue, SIZE_T cbSize, PVOID, PSIZE_T)
         *
         * An attribute of a kind Windows takes, of the size that kind has,
         * added once to a list with room left; CreateProcess reads none of
         * them here.
         */
        UpdateProcThreadAttribute: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([list, , attribute, value, size])=>{
                const wanted = attribute >>> 0;
                const length = size >>> 0;
                const fits = ATTRIBUTE_SIZES.get(wanted);
                if (!fits)
                {
                    host.setLastError(ERROR_NOT_SUPPORTED);
                    return 0;
                }
                if (!fits(length))
                {
                    host.setLastError(ERROR_BAD_LENGTH);
                    return 0;
                }
                const at = list >>> 0;
                const mask = readDword(at);
                const bit = (1 << (wanted & 0xffff)) >>> 0;
                if ((mask & bit) !== 0)
                {
                    host.setLastError(ERROR_OBJECT_NAME_EXISTS);
                    return 0;
                }
                const count = readDword(at + 8);
                if (count >= readDword(at + 4))
                {
                    host.setLastError(ERROR_GEN_FAILURE);
                    return 0;
                }
                const entry = at + ATTRIBUTE_LIST_HEADER + count * ATTRIBUTE_ENTRY;
                writeDword(entry, wanted);
                writeDword(entry + 4, length);
                writeDword(entry + 8, value >>> 0);
                writeDword(at + 8, count + 1);
                writeDword(at, (mask | bit) >>> 0);
                return 1;
            },
        },

        /** VOID DeleteProcThreadAttributeList(LPPROC_THREAD_ATTRIBUTE_LIST): nothing is held. */
        DeleteProcThreadAttributeList: { argBytes: 4, handler: ()=>0 },

        /**
         * BOOL ProcessIdToSessionId(DWORD dwProcessId, DWORD *pSessionId)
         *
         * Every process here is the interactive user's, in session one -- the
         * one WTSGetActiveConsoleSessionId names -- and an id that is no
         * process is refused.
         */
        ProcessIdToSessionId: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([id, out])=>{
                const wanted = id >>> 0;
                const known = wanted === ((host.processId ?? 0x1000) >>> 0)
                    || kernel.processes.all().some((/** @type {any} */ made)=>made.id === wanted);
                if (!known || (out >>> 0) === 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                writeDword(out >>> 0, INTERACTIVE_SESSION);
                return 1;
            },
        },

        /** DWORD WTSGetActiveConsoleSessionId(void): the interactive session. */
        WTSGetActiveConsoleSessionId: { argBytes: 0, handler: ()=>INTERACTIVE_SESSION },

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
                    if (!host.patchMemory)
                    {
                        host.writeMemory(base >>> 0, bytes);
                    }
                    else if (!host.patchMemory(base >>> 0, bytes))
                    {
                        host.setLastError(ERROR_NOACCESS);
                        return 0;
                    }
                }
                else
                {
                    // Written where the child runs, through its own protection.
                    return inChild(handle, { call: 'WriteProcessMemory',
                        args: [CURRENT_PROCESS, base >>> 0, { in: bytes }, count,
                            (written >>> 0) === 0 ? 0 : { out: 4 }] },
                    [null, null, null, null, written >>> 0]);
                }

                if ((written >>> 0) !== 0)
                {
                    writeDword(written >>> 0, count);
                }
                host.setLastError(ERROR_SUCCESS);
                return 1;
            },
        },

        /**
         * BOOL ReadProcessMemory(HANDLE hProcess, LPCVOID lpBaseAddress,
         *   LPVOID lpBuffer, SIZE_T nSize, SIZE_T *lpNumberOfBytesRead)
         *
         * Against the running process this reads memory; against a child the
         * same read is made in the child, where it runs. A range that leaves
         * mapped memory is ERROR_PARTIAL_COPY, what Windows says of memory it
         * cannot read.
         */
        ReadProcessMemory: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, base, buffer, size, read])=>{
                const count = size >>> 0;
                const from = base >>> 0;
                /** @type {Uint8Array | null} */
                let bytes;
                if ((handle >>> 0) === CURRENT_PROCESS)
                {
                    // A range that leaves mapped memory is ERROR_PARTIAL_COPY, not a
                    // fault: a crash handler walks stacks through here, reading
                    // wherever a frame pointer leads.
                    try
                    {
                        bytes = count === 0 ? new Uint8Array(0)
                            : host.readMemory(from, count).slice();
                    }
                    catch (e){
                        void e;
                        bytes = null;
                    }
                }
                else
                {
                    return inChild(handle, { call: 'ReadProcessMemory',
                        args: [CURRENT_PROCESS, from, (buffer >>> 0) === 0 ? 0 : { out: count },
                            count, (read >>> 0) === 0 ? 0 : { out: 4 }] },
                    [null, null, buffer >>> 0, null, read >>> 0]);
                }
                if (bytes === null)
                {
                    if ((read >>> 0) !== 0)
                    {
                        writeDword(read >>> 0, 0);
                    }
                    host.setLastError(ERROR_PARTIAL_COPY);
                    return 0;
                }
                if (count > 0)
                {
                    host.writeMemory(buffer >>> 0, bytes);
                }
                if ((read >>> 0) !== 0)
                {
                    writeDword(read >>> 0, count);
                }
                return 1;
            },
        },

        /**
         * BOOL QueryFullProcessImageNameA/W(HANDLE hProcess, DWORD dwFlags,
         *                                   LPSTR/LPWSTR lpExeName, PDWORD lpdwSize)
         */
        QueryFullProcessImageNameA: queryImageName(false),
        QueryFullProcessImageNameW: queryImageName(true),
    };
}
