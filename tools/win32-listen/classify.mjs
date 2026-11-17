/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a program asked of the system, sorted into the questions a person
 * bringing it up asks: which keys it read, which files it opened, which
 * libraries and functions it looked for, which processes and named objects it
 * reached for, what it showed and how it ended. A raw call log answers all of
 * them and none at a glance; a family per question, each request once with how
 * often and when it was first made, does.
 *
 * Pure functions over the records `listen.mjs` writes, so the sorting is
 * tested without running a program.
 */

/**
 * @typedef {Object} CallEntry
 * @property {number} seq        order across every process and thread of the run
 * @property {number} t          milliseconds since the run started
 * @property {string} name       the function, as the bridge names it
 * @property {number} from       the guest address the call came from
 * @property {number[]} args     the argument words the bridge kept
 * @property {(string | null)[] | null} strings  each argument read as text, where it was text
 * @property {number} [answer]   EAX as the program got it, for a call that answered
 * @property {string} kind       the bridge's kind: answered, parked, threw, ...
 * @property {number} [error]    the thread's last error after the call
 * @property {string | null} [thread]
 * @property {string | null} [image]
 */

/**
 * The families, first match wins. A name is matched without its A/W suffix
 * and its Ex form, since the question is the same whichever the program used.
 *
 * @type {[string, RegExp][]}
 */
export const FAMILIES = [
    ['registry', /^(Reg[A-Z]|SH(Reg)?[GS]etValue|SHDeleteKey|SHQueryValue|NtOpenKey|NtQueryValueKey|NtCreateKey|ZwOpenKey|ZwQueryValueKey)/],
    ['module', /^(LoadLibrary|GetModuleHandle|GetModuleFileName|GetProcAddress|FreeLibrary|LdrLoadDll|LdrGetProcedureAddress|LdrGetDllHandle|DisableThreadLibraryCalls)/],
    ['process', /^(CreateProcess|ShellExecute|WinExec|OpenProcess|TerminateProcess|ExitProcess|CreateToolhelp32Snapshot|Process32|Module32|Thread32|EnumProcess|GetCurrentProcessId|GetExitCodeProcess|ProcessIdToSessionId|NtQuerySystemInformation|ReadProcessMemory|WriteProcessMemory)/],
    ['ipc', /^(CreateFileMapping|OpenFileMapping|MapViewOfFile|UnmapViewOfFile|CreateEvent|OpenEvent|CreateMutex|OpenMutex|CreateSemaphore|OpenSemaphore|CreateNamedPipe|ConnectNamedPipe|WaitNamedPipe|CallNamedPipe|TransactNamedPipe|PeekNamedPipe|SetNamedPipeHandleState|CreateMailslot|GlobalAddAtom|GlobalFindAtom|RegisterWindowMessage|FindWindow|SendMessage|PostMessage)/],
    ['crypto', /^(WinVerifyTrust|WTHelper|Crypt[A-Z]|Cert[A-Z]|BCrypt|NCrypt|CryptCATAdmin)/],
    ['debug', /^(IsDebuggerPresent|CheckRemoteDebuggerPresent|NtQueryInformationProcess|ZwQueryInformationProcess|NtSetInformationThread|OutputDebugString|GetThreadContext|SetThreadContext|SetUnhandledExceptionFilter|AddVectoredExceptionHandler|RaiseException|DebugBreak|NtQueryObject)/],
    ['file', /^(CreateFile|OpenFile|_lopen|_lcreat|ReadFile|WriteFile|SetFilePointer|GetFileSize|GetFileAttributes|SetFileAttributes|GetFileInformationByHandle|GetFileTime|FindFirstFile|FindNextFile|FindClose|DeleteFile|CopyFile|MoveFile|CreateDirectory|RemoveDirectory|GetFullPathName|SearchPath|GetCurrentDirectory|SetCurrentDirectory|GetTempPath|GetTempFileName|GetSystemDirectory|GetWindowsDirectory|GetDriveType|GetVolumeInformation|GetDiskFreeSpace|GetLogicalDrive|DeviceIoControl|NtCreateFile|NtOpenFile)/],
    ['environment', /^(GetEnvironmentVariable|SetEnvironmentVariable|GetEnvironmentStrings|ExpandEnvironmentStrings|GetCommandLine|GetStartupInfo|GetVersion|GetComputerName|GetUserName|GetSystemInfo|GetNativeSystemInfo|IsWow64Process|GetUserDefault|GetSystemDefault)/],
    ['clock', /^(GetTickCount|QueryPerformanceCounter|QueryPerformanceFrequency|timeGetTime|GetSystemTime|GetLocalTime|NtQuerySystemTime|Sleep)/],
    ['memory', /^(Virtual(Alloc|Free|Protect|Query|Lock|Unlock)|IsBad(Read|Write|Code|String)Ptr|FlushInstructionCache|NtProtectVirtualMemory|NtAllocateVirtualMemory)/],
    ['ui', /^(MessageBox|DialogBox|CreateDialog|CreateWindow|ShowWindow|EndDialog|MessageBeep)/],
    ['network', /^(WSA|socket|connect|send|recv|gethost|getaddrinfo|closesocket|select|bind|listen|accept|InternetOpen|InternetConnect|HttpOpenRequest|WinHttp)/],
    ['thread', /^(CreateThread|ExitThread|TerminateThread|ResumeThread|SuspendThread|GetExitCodeThread|SetThreadAffinityMask|GetProcessAffinityMask|SetThreadPriority|WaitFor(Single|Multiple)Object)/],
];

/**
 * @param {string} name
 * @returns {string}
 */
export function familyOf(name){
    const bare = name.replace(/^.*[!.]/, '');
    for (const [family, pattern] of FAMILIES)
    {
        if (pattern.test(bare))
        {
            return family;
        }
    }
    return 'other';
}

/** @param {number} value */
const hex = value=>`0x${(value >>> 0).toString(16)}`;

/**
 * Functions whose first argument is a module handle. A handle is the address
 * of the module's header, so read as text it says "MZ" for every module and
 * names none of them; the word itself does.
 */
const TAKES_MODULE = /(GetProcAddress|GetModuleFileName[AW]?|FreeLibrary|LdrGetProcedureAddress|FindResource[AW]?|LoadResource|LoadString[AW]?)$/;

/**
 * An argument as a person reads it: its text where it was text, else the word.
 * GetProcAddress's name is an ordinal when it is below 0x10000, which is how
 * the real function tells the two apart.
 *
 * @param {CallEntry} entry @param {number} index
 */
function argumentText(entry, index){
    const word = entry.args[index] >>> 0;
    const text = entry.strings?.[index];
    if (typeof text === 'string' && !(index === 0 && TAKES_MODULE.test(entry.name)))
    {
        return JSON.stringify(text);
    }
    if (index === 1 && /GetProcAddress$/.test(entry.name) && word < 0x10000)
    {
        return `#${word}`;
    }
    return hex(word);
}

/**
 * One call as a line: time, thread, caller, the call with its arguments, the
 * answer and the error it left.
 *
 * @param {CallEntry} entry
 * @returns {string}
 */
export function formatCall(entry){
    const args = entry.args.map((_, index)=>argumentText(entry, index)).join(', ');
    const answer = entry.kind === 'answered' && entry.answer !== undefined
        ? hex(entry.answer) : entry.kind;
    const error = entry.error ? ` err=${entry.error}` : '';
    return `${(entry.t / 1000).toFixed(3).padStart(9)} ${String(entry.thread ?? '-').padEnd(8)}`
        + ` ${hex(entry.from).padStart(10)} ${entry.name}(${args}) = ${answer}${error}`;
}

/**
 * What makes two calls the same request: the function and the text it was
 * given. Handles and buffer addresses differ between calls that ask the same
 * question, so a call with no text at all is one request per function; a
 * module handle is the exception, since the same name asked of two modules is
 * two questions.
 *
 * @param {CallEntry} entry
 */
export function requestKey(entry){
    const texts = (entry.strings ?? []).map((text, index)=>(typeof text === 'string'
        || (index === 1 && /GetProcAddress$/.test(entry.name))
        || (index === 0 && TAKES_MODULE.test(entry.name))
        ? `${index}:${argumentText(entry, index)}` : null)).filter(Boolean);
    return `${entry.name}|${texts.join('|')}`;
}

/**
 * @typedef {Object} Request
 * @property {string} key
 * @property {CallEntry} first   the first call that made it
 * @property {number} count
 * @property {Set<string>} answers  every answer it got, so a request answered
 *           differently over the run shows it
 */

/**
 * Every request once, by family, in the order each was first made.
 *
 * @param {Iterable<CallEntry>} entries
 * @returns {Map<string, Request[]>}
 */
export function summarize(entries){
    /** @type {Map<string, Request>} */
    const requests = new Map();
    /** @type {Map<string, Request[]>} */
    const families = new Map();
    for (const entry of entries)
    {
        const key = requestKey(entry);
        let request = requests.get(key);
        if (request === undefined)
        {
            request = { key, first: entry, count: 0, answers: new Set() };
            requests.set(key, request);
            const family = familyOf(entry.name);
            families.set(family, [...families.get(family) ?? [], request]);
        }
        request.count++;
        if (request.answers.size < 8)
        {
            request.answers.add(entry.kind === 'answered' && entry.answer !== undefined
                ? hex(entry.answer) : entry.kind);
        }
    }
    return families;
}

/** The order families are printed in: the questions of a bring-up first. */
const PRINT_ORDER = ['registry', 'file', 'module', 'process', 'ipc', 'crypto', 'debug', 'ui',
    'environment', 'network', 'thread', 'memory', 'clock', 'other'];

/**
 * The summary as text: a section a family, a line a request.
 *
 * @param {Map<string, Request[]>} families
 * @param {{ limit?: number }} [options]  requests printed a family; the rest are counted
 * @returns {string}
 */
export function renderSummary(families, { limit = 200 } = {}){
    const lines = [];
    for (const family of PRINT_ORDER)
    {
        const requests = families.get(family);
        if (!requests)
        {
            continue;
        }
        const calls = requests.reduce((sum, request)=>sum + request.count, 0);
        lines.push(`== ${family}: ${requests.length} requests, ${calls} calls`);
        for (const request of requests.slice(0, limit))
        {
            const answers = [...request.answers].join(',');
            lines.push(`${formatCall(request.first)}  x${request.count}`
                + (request.answers.size > 1 ? ` answers=${answers}` : ''));
        }
        if (requests.length > limit)
        {
            lines.push(`   ... ${requests.length - limit} more`);
        }
        lines.push('');
    }
    return lines.join('\n');
}
