/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * dbghelp — the debug help library, on a machine with no symbol files.
 *
 * What imports it is a crash reporter: its unhandled-exception filter walks the
 * faulting thread's stack, names each frame's module and asks for symbols and
 * source lines, and writes the lot to a file before the process ends. Every
 * answer it is given here is one the real library gives a process whose images
 * carry no debug information: the session opens, modules are known by where
 * they are mapped, the stack is walked along its frame pointers, and a symbol
 * or a line is not found -- which a reporter prints as a bare address.
 */

const ERROR_INVALID_ADDRESS = 487;
const ERROR_MOD_NOT_FOUND = 126;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ALREADY_EXISTS = 183;

/** SymGetOptions before a program sets any: names are undecorated. */
const SYMOPT_UNDNAME = 0x2;

/** IMAGE_FILE_MACHINE_I386, the only machine a 32-bit walk is asked for. */
const IMAGE_FILE_MACHINE_I386 = 0x14c;

/**
 * STACKFRAME (x86): four ADDRESS records of 12 bytes -- Offset, Segment, Mode
 * -- then FuncTableEntry, Params[4], Far, Virtual, Reserved[3].
 */
const STACKFRAME = Object.freeze({
    AddrPC: 0, AddrReturn: 12, AddrFrame: 24, AddrStack: 36,
    Params: 52, Reserved: 76, size: 88,
});

/** ADDRESS.Mode AddrModeFlat. */
const ADDR_MODE_FLAT = 3;

/**
 * Written into Reserved[0] once a frame has been reported: what tells the
 * first call of a walk, which reports the frame it was given, from the ones
 * after it, which step to the caller.
 */
const WALK_STARTED = 0x4b4c4157;

/**
 * @typedef {Object} DbghelpHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 *           Throws, or answers short, where nothing is mapped.
 * @property {() => { base: number, size: number }[]} modules
 *           The modules of the process, as Toolhelp lists them.
 * @property {(code: number) => void} setLastError
 * @property {(address: number) => string} [readCString]
 * @property {{ stat: (path: string) => { exists: boolean, isDirectory: boolean } | null,
 *     mkdir: (path: string) => boolean, currentDirectory?: () => string }} [files]
 *           The volume, for MakeSureDirectoryPathExists.
 */

/**
 * @param {DbghelpHost} host
 * @returns {Record<string, { argBytes: number, handler: (args: number[]) => number }>}
 */
export function createDbghelpFunctions(host){
    let options = SYMOPT_UNDNAME;

    /** @param {number} address @returns {number | null} */
    const readU32 = address=>{
        try
        {
            const bytes = host.readMemory(address >>> 0, 4);
            if (bytes.length < 4)
            {
                return null;
            }
            return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
        }
        catch (e){
            void e;
            return null;
        }
    };

    /** @param {number} address */
    const moduleBase = address=>{
        const at = address >>> 0;
        const module = host.modules()
            .find(each=>at >= each.base >>> 0 && at < (each.base >>> 0) + (each.size >>> 0));
        return module ? module.base >>> 0 : 0;
    };

    /** @param {number} answer @param {number} code */
    const fail = (answer, code)=>{
        host.setLastError(code);
        return answer;
    };

    return {
        /** DWORD SymGetOptions(void) */
        SymGetOptions: { argBytes: 0, handler: ()=>options },

        /** DWORD SymSetOptions(DWORD SymOptions): the options now in force. */
        SymSetOptions: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([value])=>{
                options = value >>> 0;
                return options;
            },
        },

        /**
         * BOOL MakeSureDirectoryPathExists(PCSTR DirPath)
         *
         * Every directory of the path, made where it is missing. The last
         * component is a directory only when the path ends in a backslash;
         * otherwise it is a file's name and is left alone. A directory that
         * is already there is no failure; a file where a directory is wanted,
         * or a directory that cannot be made, is.
         */
        MakeSureDirectoryPathExists: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                if ((pointer >>> 0) === 0 || !host.readCString || !host.files)
                {
                    return fail(0, ERROR_INVALID_PARAMETER);
                }
                const files = host.files;
                const given = host.readCString(pointer >>> 0).replace(/\//g, '\\');
                const absolute = /^[A-Za-z]:\\/.test(given) ? given
                    : `${(files.currentDirectory?.() ?? 'C:\\').replace(/\\$/, '')}\\${given}`;
                const parts = absolute.split('\\');
                // The last part is a file's name, or empty after a closing backslash.
                parts.pop();
                let path = parts.shift() ?? '';
                for (const part of parts)
                {
                    if (part === '')
                    {
                        continue;
                    }
                    path = `${path}\\${part}`;
                    const entry = files.stat(path);
                    if (entry?.exists)
                    {
                        if (!entry.isDirectory)
                        {
                            return fail(0, ERROR_ALREADY_EXISTS);
                        }
                        continue;
                    }
                    if (!files.mkdir(path))
                    {
                        return fail(0, ERROR_PATH_NOT_FOUND);
                    }
                }
                return 1;
            },
        },

        /** BOOL SymInitialize(HANDLE hProcess, PCSTR UserSearchPath, BOOL fInvadeProcess) */
        SymInitialize: { argBytes: 12, handler: ()=>1 },

        /** BOOL SymCleanup(HANDLE hProcess) */
        SymCleanup: { argBytes: 4, handler: ()=>1 },

        /**
         * DWORD SymLoadModule(HANDLE hProcess, HANDLE hFile, PCSTR ImageName,
         *     PCSTR ModuleName, DWORD BaseOfDll, DWORD SizeOfDll)
         *
         * The base the module is known by, which is where it is mapped; with no
         * symbols to read there is nothing else to load.
         */
        SymLoadModule: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([, , , , base])=>{
                return (base >>> 0) !== 0 ? base >>> 0 : fail(0, ERROR_MOD_NOT_FOUND);
            },
        },

        /** DWORD SymGetModuleBase(HANDLE hProcess, DWORD dwAddr): 0 outside every module. */
        SymGetModuleBase: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, address])=>{
                const base = moduleBase(address);
                return base !== 0 ? base : fail(0, ERROR_MOD_NOT_FOUND);
            },
        },

        /**
         * PVOID SymFunctionTableAccess(HANDLE hProcess, DWORD AddrBase): an x86
         * image has no function tables, and no symbols means no frame data.
         */
        SymFunctionTableAccess: { argBytes: 8, handler: ()=>0 },

        /**
         * BOOL SymGetSymFromAddr(HANDLE hProcess, DWORD Address,
         *     PDWORD Displacement, PIMAGEHLP_SYMBOL Symbol): no symbol is known.
         */
        SymGetSymFromAddr: { argBytes: 16, handler: ()=>fail(0, ERROR_INVALID_ADDRESS) },

        /**
         * BOOL SymGetLineFromAddr(HANDLE hProcess, DWORD dwAddr,
         *     PDWORD pdwDisplacement, PIMAGEHLP_LINE Line): no line is known.
         */
        SymGetLineFromAddr: { argBytes: 16, handler: ()=>fail(0, ERROR_INVALID_ADDRESS) },

        /**
         * BOOL StackWalk(DWORD MachineType, HANDLE hProcess, HANDLE hThread,
         *     LPSTACKFRAME StackFrame, PVOID ContextRecord,
         *     PREAD_PROCESS_MEMORY_ROUTINE ReadMemoryRoutine,
         *     PFUNCTION_TABLE_ACCESS_ROUTINE FunctionTableAccessRoutine,
         *     PGET_MODULE_BASE_ROUTINE GetModuleBaseRoutine,
         *     PTRANSLATE_ADDRESS_ROUTINE TranslateAddress)
         *
         * One frame a call along the EBP chain. The first call reports the
         * frame the caller filled in from the context; each later one steps to
         * the caller's frame. The walk ends, FALSE, where the chain leaves
         * mapped memory or reaches a zero frame or return address. The memory
         * read is this process's, which is what the default routines read; a
         * routine the caller passes would answer the same.
         */
        StackWalk: {
            argBytes: 36,
            /** @param {number[]} args */
            handler: ([machine, , , frameAddress])=>{
                if ((machine >>> 0) !== IMAGE_FILE_MACHINE_I386 || (frameAddress >>> 0) === 0)
                {
                    return fail(0, ERROR_INVALID_PARAMETER);
                }
                const at = frameAddress >>> 0;
                const field = (/** @type {number} */ offset)=>readU32(at + offset) ?? 0;
                let pc = field(STACKFRAME.AddrPC);
                let frame = field(STACKFRAME.AddrFrame);
                let stack = field(STACKFRAME.AddrStack);
                if (field(STACKFRAME.Reserved) === WALK_STARTED)
                {
                    const caller = readU32(frame);
                    const returnTo = readU32(frame + 4);
                    if (caller === null || returnTo === null || returnTo === 0)
                    {
                        return 0;
                    }
                    pc = returnTo;
                    stack = (frame + 8) >>> 0;
                    frame = caller;
                }
                if (frame === 0 || pc === 0)
                {
                    return 0;
                }
                const returnAddress = readU32(frame + 4);
                if (returnAddress === null)
                {
                    return 0;
                }
                const out = new DataView(new ArrayBuffer(STACKFRAME.size));
                /** @param {number} offset @param {number} value */
                const address = (offset, value)=>{
                    out.setUint32(offset, value >>> 0, true);
                    out.setUint32(offset + 8, ADDR_MODE_FLAT, true);
                };
                address(STACKFRAME.AddrPC, pc);
                address(STACKFRAME.AddrReturn, returnAddress);
                address(STACKFRAME.AddrFrame, frame);
                address(STACKFRAME.AddrStack, stack);
                for (let index = 0; index < 4; index++)
                {
                    const parameter = readU32(frame + 8 + index * 4) ?? 0;
                    out.setUint32(STACKFRAME.Params + index * 4, parameter, true);
                }
                out.setUint32(STACKFRAME.Reserved, WALK_STARTED, true);
                host.writeMemory(at, new Uint8Array(out.buffer));
                return 1;
            },
        },
    };
}
