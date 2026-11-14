/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * mscoree - the .NET runtime's shim, as Windows 7 and later carry it in the
 * system folder. It holds no runtime: every export is the same-named export of
 * the shim's implementation the .NET Framework 4 installs,
 * `<InstallRoot>v4.0.30319\mscoreei.dll`, loaded on the first call that needs
 * it and handed the program's call as it came. Only two exports are its own:
 * the loader's notifications `_CorValidateImage` and `_CorImageUnloading`,
 * which mscoreei does not export.
 *
 * Each export is a few instructions of guest code beside a slot: the slot
 * empty, the code calls a trap that loads mscoreei, finds the export and
 * writes its address into the slot; from then on the code jumps straight
 * there, with the caller's stack and return address untouched, and no call
 * crosses into the host again. A machine with no Framework answers what each
 * export answers when the runtime cannot be loaded.
 */

/** The runtime could not be loaded: what a hosting call answers without one. */
export const CLR_E_SHIM_RUNTIMELOAD = 0x80131700;
const CLASS_E_CLASSNOTAVAILABLE = 0x80040111;
const S_OK = 0;
/** What ends a process whose runtime is missing (A247). */
export const STATUS_DLL_NOT_FOUND = 0xc0000135;

/** The one directory every .NET Framework 4.x installs into, under InstallRoot. */
export const FRAMEWORK_V4 = 'v4.0.30319';
/** The shim's implementation, in that directory. */
export const SHIM_IMPLEMENTATION = 'mscoreei.dll';

/**
 * How an export answers when there is no runtime: an HRESULT, BOOL or BOOLEAN,
 * or nothing (0 for a void function); `end` ends the process, said as a loss -
 * the managed entry points, which Windows ends the process at, and every
 * export whose arguments are not published, which cannot be answered without
 * knowing what to take off the stack; `exit` ends it with the code given.
 *
 * @typedef {number | 'end' | 'exit'} Failure
 */

const HR = CLR_E_SHIM_RUNTIMELOAD;
const FALSE = 0;
const VOID = 0;

/**
 * Every export Windows' mscoree.dll has that mscoreei.dll has too: [name, or
 * `#n` for one exported by number alone, argument bytes (stdcall), the answer
 * without a runtime]. Argument bytes are
 * null where the signature is not published; such an export ends the process
 * when no runtime is there to take it. `GetCLRMetaHost` is the one name of
 * Windows' table mscoreei lacks with no published signature, and is left out.
 *
 * @type {readonly (readonly [string, number | null, Failure])[]}
 */
export const MSCOREE_FORWARDS = Object.freeze([
    ['InitErrors', null, 'end'],
    ['PostError', null, 'end'],
    ['InitSSAutoEnterThread', null, 'end'],
    ['UpdateError', null, 'end'],
    ['CloseCtrs', null, 'end'],
    ['LoadStringRC', 16, HR],
    ['ReOpenMetaDataWithMemory', null, 'end'],
    // Exported by number alone, as mscoreei's own 24 is; the CLR asks for it.
    ['#24', null, 'end'],
    ['CollectCtrs', null, 'end'],
    ['CorDllMainWorker', null, 'end'],
    ['EEDllGetClassObjectFromClass', null, 'end'],
    ['GetPrivateContextsPerfCounters', null, 'end'],
    ['GetProcessExecutableHeap', null, 'end'],
    ['GetStartupFlags', null, 'end'],
    ['GetTargetForVTableEntry', 8, VOID],
    ['GetTokenForVTableEntry', 8, HR],
    ['LogHelp_LogAssert', null, 'end'],
    ['LogHelp_NoGuiOnAssert', null, 'end'],
    ['LogHelp_TerminateOnAssert', null, 'end'],
    ['OpenCtrs', null, 'end'],
    ['SetTargetForVTableEntry', 12, HR],
    ['CLRCreateInstance', 12, HR],
    ['CallFunctionShim', 24, HR],
    ['ClrCreateManagedInstance', 12, HR],
    ['CoEEShutDownCOM', 0, VOID],
    ['CoInitializeCor', 4, HR],
    ['CoInitializeEE', 4, HR],
    ['CoUninitializeCor', 0, VOID],
    ['CoUninitializeEE', 4, VOID],
    ['CorBindToCurrentRuntime', 16, HR],
    ['CorBindToRuntime', 20, HR],
    ['CorBindToRuntimeByCfg', 24, HR],
    ['CorBindToRuntimeByPath', null, 'end'],
    ['CorBindToRuntimeByPathEx', null, 'end'],
    ['CorBindToRuntimeEx', 24, HR],
    ['CorBindToRuntimeHost', 32, HR],
    ['CorExitProcess', 4, 'exit'],
    ['CorGetSvc', null, 'end'],
    ['CorIsLatestSvc', null, 'end'],
    ['CorMarkThreadInThreadPool', 0, VOID],
    ['CorTickleSvc', null, 'end'],
    ['CreateConfigStream', 8, HR],
    ['CreateDebuggingInterfaceFromVersion', 12, HR],
    ['CreateInterface', 12, HR],
    ['DllCanUnloadNow', 0, S_OK],
    ['DllGetClassObject', 12, CLASS_E_CLASSNOTAVAILABLE],
    ['DllRegisterServer', 0, HR],
    ['DllUnregisterServer', 0, HR],
    ['EEDllRegisterServer', null, 'end'],
    ['EEDllUnregisterServer', null, 'end'],
    ['GetAssemblyMDImport', 12, HR],
    ['GetCORRequiredVersion', 12, HR],
    ['GetCORRootDirectory', 12, HR],
    ['GetCORSystemDirectory', 12, HR],
    ['GetCORVersion', 12, HR],
    ['GetCompileInfo', null, 'end'],
    ['GetFileVersion', 16, HR],
    ['GetHashFromAssemblyFile', 20, HR],
    ['GetHashFromAssemblyFileW', 20, HR],
    ['GetHashFromBlob', 24, HR],
    ['GetHashFromFile', 20, HR],
    ['GetHashFromFileW', 20, HR],
    ['GetHashFromHandle', 20, HR],
    ['GetHostConfigurationFile', 8, HR],
    ['GetMetaDataInternalInterface', 20, HR],
    ['GetMetaDataInternalInterfaceFromPublic', 12, HR],
    ['GetMetaDataPublicInterfaceFromInternal', 12, HR],
    ['GetPermissionRequests', 28, HR],
    ['GetRealProcAddress', 8, HR],
    ['GetRequestedRuntimeInfo', 44, HR],
    ['GetRequestedRuntimeVersion', 16, HR],
    ['GetRequestedRuntimeVersionForCLSID', 20, HR],
    ['GetVersionFromProcess', 16, HR],
    ['GetXMLElement', null, 'end'],
    ['GetXMLElementAttribute', null, 'end'],
    ['GetXMLObject', null, 'end'],
    ['IEE', null, 'end'],
    ['LoadLibraryShim', 16, HR],
    ['LoadLibraryWithPolicyShim', 20, HR],
    ['LoadStringRCEx', 24, HR],
    ['LockClrVersion', 12, HR],
    ['MetaDataGetDispenser', 12, HR],
    ['ND_CopyObjDst', null, 'end'],
    ['ND_CopyObjSrc', null, 'end'],
    ['ND_RI2', null, 'end'],
    ['ND_RI4', null, 'end'],
    ['ND_RI8', null, 'end'],
    ['ND_RU1', null, 'end'],
    ['ND_WI2', null, 'end'],
    ['ND_WI4', null, 'end'],
    ['ND_WI8', null, 'end'],
    ['ND_WU1', null, 'end'],
    ['ReOpenMetaDataWithMemoryEx', null, 'end'],
    ['RunDll32ShimW', 16, HR],
    ['RuntimeOSHandle', null, 'end'],
    ['RuntimeOpenImage', null, 'end'],
    ['RuntimeReleaseHandle', null, 'end'],
    ['StrongNameCompareAssemblies', 12, FALSE],
    ['StrongNameErrorInfo', 0, HR],
    ['StrongNameFreeBuffer', 4, VOID],
    ['StrongNameGetBlob', 12, FALSE],
    ['StrongNameGetBlobFromImage', 16, FALSE],
    ['StrongNameGetPublicKey', 20, FALSE],
    ['StrongNameHashSize', 8, FALSE],
    ['StrongNameKeyDelete', 4, FALSE],
    ['StrongNameKeyGen', 16, FALSE],
    ['StrongNameKeyGenEx', 20, FALSE],
    ['StrongNameKeyInstall', 12, FALSE],
    ['StrongNameSignatureGeneration', 24, FALSE],
    ['StrongNameSignatureGenerationEx', 28, FALSE],
    ['StrongNameSignatureSize', 12, FALSE],
    ['StrongNameSignatureVerification', 12, FALSE],
    ['StrongNameSignatureVerificationEx', 12, FALSE],
    ['StrongNameSignatureVerificationFromImage', 16, FALSE],
    ['StrongNameTokenFromAssembly', 12, FALSE],
    ['StrongNameTokenFromAssemblyEx', 20, FALSE],
    ['StrongNameTokenFromPublicKey', 16, FALSE],
    ['TranslateSecurityAttributes', null, 'end'],
    ['_CorDllMain', 12, FALSE],
    ['_CorExeMain2', 20, 'end'],
    ['_CorExeMain', 0, 'end'],
]);

/**
 * The numbers Windows' table gives the exports, which a program may import
 * them by: from 17 in MSCOREE_FORWARDS' order, past 68 (`GetCLRMetaHost`);
 * then mscoree's own two, and 142, which has no name and is kernel32's
 * GetVersionExW - the CLR asks for it by number.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const MSCOREE_ORDINALS = Object.freeze(Object.fromEntries([
    // GetCLRMetaHost's 68 is the one number the forwards skip.
    ...MSCOREE_FORWARDS.map(([name], index)=>[17 + index + (17 + index >= 68 ? 1 : 0), name]),
    [139, '_CorImageUnloading'], [140, '_CorValidateImage'], [142, 'GetVersionExW']]));

/** The stub's length and where its two traps' displacements are. */
const STUB_LENGTH = 25;
const RESOLVE_AT = 10;
const FAIL_AT = 21;

/**
 * An export's guest code, at `at`, its slot at `slot`:
 *
 *     mov eax, [slot]   ; mscoreei's export, once found
 *     test eax, eax
 *     jnz go
 *     call resolve      ; finds it and fills the slot, or answers 0
 *     test eax, eax
 *     jz fail
 *     go: jmp eax       ; the caller's frame as it came
 *     fail: jmp failed  ; the answer without a runtime
 *
 * EAX is the only register it changes, which no convention keeps across a
 * call.
 *
 * @param {number} at @param {number} slot @param {number} resolve @param {number} failed
 * @returns {Uint8Array}
 */
export function forwardingStub(at, slot, resolve, failed){
    const code = Uint8Array.of(
        0xa1, 0, 0, 0, 0,
        0x85, 0xc0,
        0x75, 0x09,
        0xe8, 0, 0, 0, 0,
        0x85, 0xc0,
        0x74, 0x02,
        0xff, 0xe0,
        0xe9, 0, 0, 0, 0);
    const view = new DataView(code.buffer);
    view.setUint32(1, slot, true);
    view.setInt32(RESOLVE_AT, (resolve - (at + RESOLVE_AT + 4)) | 0, true);
    view.setInt32(FAIL_AT, (failed - (at + FAIL_AT + 4)) | 0, true);
    return code;
}

/**
 * @typedef {Object} MscoreeHost
 * @property {(bytes: number) => number} allocate      Writable guest memory, 0 when none.
 * @property {(bytes: number) => number} allocateCode  Executable guest memory, 0 when none.
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {() => string | null} installRoot  The registry's InstallRoot, null when absent.
 * @property {() => string} windowsDirectory
 * @property {(path: string) => boolean} exists
 * @property {(path: string) => number | Promise<number>} loadLibrary  LoadLibrary's answer.
 * @property {(module: number, name: string | number) => number | Promise<number>} procAddress
 *           GetProcAddress's answer, for a name or a number.
 * @property {(code: number) => any} exitProcess  ExitProcess, called by the program.
 * @property {(api: string, detail: string, kind?: 'loss') => void} [divergence]
 */

/**
 * @param {MscoreeHost} host
 * @returns {Record<string, any>}
 */
export function createMscoreeFunctions(host){
    /** Where the Framework's shim implementation would be. */
    const shimPath = ()=>{
        const root = host.installRoot()
            ?? `${host.windowsDirectory().replace(/\\$/, '')}\\Microsoft.NET\\Framework\\`;
        return `${root.replace(/\\?$/, '\\')}${FRAMEWORK_V4}\\${SHIM_IMPLEMENTATION}`;
    };

    /** @type {Promise<number> | null} */
    let shim = null;
    /** Loaded once, on the first call that needs it; 0 when there is none. */
    const loadShim = ()=>(shim ??= (async()=>{
        const path = shimPath();
        return host.exists(path) ? (await host.loadLibrary(path)) >>> 0 : 0;
    })());

    /** The slots, one dword an export, made with the first stub. */
    let slots = 0;

    /** @param {string} name @param {string} detail */
    const lost = (name, detail)=>host.divergence?.(name, detail, 'loss');

    /**
     * The answer without the runtime.
     *
     * @param {string} name @param {Failure} failure
     */
    const failedHandler = (name, failure)=>(/** @type {number[]} */ args)=>{
        if (failure === 'exit')
        {
            return host.exitProcess(args[0] >>> 0);
        }
        if (failure === 'end')
        {
            lost(name, `no .NET Framework is installed (${shimPath()} is not there): `
                + 'the process ends');
            return host.exitProcess(STATUS_DLL_NOT_FOUND);
        }
        if (name === '_CorDllMain')
        {
            lost(name, `no .NET Framework is installed (${shimPath()} is not there): `
                + 'a managed library does not load');
        }
        return failure;
    };

    /**
     * Finds mscoreei's export and fills its slot; 0 when there is none.
     *
     * @param {string} name @param {number} slot
     */
    const resolve = async(name, slot)=>{
        const module = await loadShim();
        if (module === 0)
        {
            return 0;
        }
        const target = (await host.procAddress(module,
            name.startsWith('#') ? Number(name.slice(1)) : name)) >>> 0;
        if (target === 0)
        {
            lost(name, `${shimPath()} exports no ${name}: answered as with no runtime`);
            return 0;
        }
        const word = new Uint8Array(4);
        new DataView(word.buffer).setUint32(0, target, true);
        host.writeMemory(slot, word);
        return target;
    };

    /** @type {Record<string, any>} */
    const table = {};
    MSCOREE_FORWARDS.forEach(([name, argBytes, failure], index)=>{
        const failed = { argBytes: argBytes ?? 0, handler: failedHandler(name, failure) };
        table[name] = {
            argBytes: argBytes ?? 0,
            /** @param {{ register: (label: string, trap: any) => number }} bind */
            guest: ({ register })=>{
                const failTrap = register(`mscoree.dll!${name}`, failed);
                if (slots === 0)
                {
                    slots = host.allocate(MSCOREE_FORWARDS.length * 4);
                    if (slots !== 0)
                    {
                        host.writeMemory(slots, new Uint8Array(MSCOREE_FORWARDS.length * 4));
                    }
                }
                const at = slots === 0 ? 0 : host.allocateCode(STUB_LENGTH);
                if (at === 0)
                {
                    // ponytail: with no room for the stub the export answers as
                    // without a runtime; a trap that forwards through a guest call
                    // if this is ever hit.
                    return failTrap;
                }
                const slot = slots + index * 4;
                const resolveTrap = register(`mscoree.dll!${name}`,
                    { argBytes: 0, handler: ()=>resolve(name, slot) });
                host.writeMemory(at, forwardingStub(at, slot, resolveTrap, failTrap));
                return at;
            },
        };
    });

    return {
        ...table,

        /**
         * HRESULT _CorValidateImage(PVOID *ImageBase, LPCWSTR FileName)
         *
         * The operating system loader's question about a managed image. This
         * engine's loader runs an image's own entry point, whose jump to
         * _CorExeMain or _CorDllMain reaches the runtime as on XP; the image
         * is taken as it is and its entry point left alone.
         */
        _CorValidateImage: {
            argBytes: 8,
            handler: ()=>{
                host.divergence?.('_CorValidateImage',
                    'the image is not checked and its entry point not changed');
                return S_OK;
            },
        },

        /** VOID _CorImageUnloading(PVOID ImageBase): nothing was kept for it. */
        _CorImageUnloading: { argBytes: 4, handler: ()=>VOID },
    };
}
