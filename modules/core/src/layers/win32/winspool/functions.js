/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * winspool — the print spooler, of which this machine has none.
 *
 * A program built on an application framework imports these whether or not it
 * ever prints, and the library has to be there for it to load at all. A
 * machine with no printer installed answers the same way a real one does:
 * there is no printer by that name, so nothing opens and nothing has
 * properties. Each is declared so it pops what it was pushed.
 *
 * Four families follow from that one fact. A listing succeeds and lists
 * nothing. A call on a printer, job or form handle is handed a handle no call
 * here ever gave out. A call naming a printer, monitor, driver or print
 * processor names one that does not exist. And a change to the spooler's own
 * setup -- adding a printer, a driver, a monitor -- is refused as it is for a
 * user who may not make it. What exists without any printer, the spooler's
 * directories, is answered for real.
 */

/** ERROR_INVALID_PRINTER_NAME: what opening a printer that is not there says. */
const ERROR_INVALID_PRINTER_NAME = 1801;
const ERROR_SUCCESS = 0;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_NOT_SUPPORTED = 50;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_INVALID_LEVEL = 124;
const ERROR_CANCELLED = 1223;
const RPC_S_SERVER_UNAVAILABLE = 1722;
const RPC_X_NULL_REF_POINTER = 1780;
const ERROR_INVALID_USER_BUFFER = 1784;
const ERROR_UNKNOWN_PRINTER_DRIVER = 1797;
const ERROR_UNKNOWN_PRINTPROCESSOR = 1798;
const ERROR_INVALID_ENVIRONMENT = 1805;
const ERROR_UNKNOWN_PRINT_MONITOR = 3000;

const TRUE = 1;
const FALSE = 0;

/**
 * The printing environments by name, case-insensitive, and the directory each
 * keeps its files under. An absent or empty one is this machine's own.
 */
const ENVIRONMENTS = new Map([
    ['windows nt x86', 'W32X86'],
    ['windows 4.0', 'WIN40'],
    ['windows x64', 'x64'],
    ['windows ia64', 'IA64'],
]);
const OWN_ENVIRONMENT = 'W32X86';

/** Where the spooler keeps drivers and print processors, under the Windows directory. */
const DRIVER_ROOT = 'C:\\WINDOWS\\system32\\spool\\DRIVERS\\';
const PROCESSOR_ROOT = 'C:\\WINDOWS\\system32\\spool\\PRTPROCS\\';

/**
 * @typedef {Object} SpoolerHost
 * @property {(code: number) => void} [setLastError]
 * @property {(address: number, bytes: Uint8Array) => void} [writeMemory]
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 *           Without it the names a caller passes are not read: every one is
 *           taken to be present, and every environment to be this machine's.
 */

/**
 * @param {SpoolerHost} host
 */
export function createSpoolerFunctions(host){
    /** @param {number} code @returns {number} FALSE, so a handler can return it directly */
    const fail = code=>{
        host.setLastError?.(code);
        return FALSE;
    };

    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory?.(address >>> 0, bytes);
    };

    /**
     * A string argument, or null when there is no memory to read it from.
     * A null pointer is the empty string, which is what every call here
     * takes it to mean.
     *
     * @param {number} pointer @param {boolean} wide
     * @returns {string | null}
     */
    const readString = (pointer, wide)=>{
        if ((pointer >>> 0) === 0)
        {
            return '';
        }
        if (!host.readMemory)
        {
            return null;
        }
        const units = [];
        const width = wide ? 2 : 1;
        for (let at = pointer >>> 0; units.length < 1024; at += width)
        {
            const bytes = host.readMemory(at, width);
            const unit = wide ? bytes[0] | bytes[1] << 8 : bytes[0];
            if (unit === 0)
            {
                break;
            }
            units.push(unit);
        }
        return String.fromCharCode(...units);
    };

    /**
     * The directory name of a printing environment, or null for one there is
     * no such thing as.
     *
     * @param {number} pointer @param {boolean} wide
     */
    const environmentOf = (pointer, wide)=>{
        const name = readString(pointer, wide);
        if (name === null || name === '')
        {
            return OWN_ENVIRONMENT;
        }
        return ENVIRONMENTS.get(name.toLowerCase()) ?? null;
    };

    /**
     * A listing of what the spooler has, which is nothing: none needed and
     * none returned, and the last error cleared, as on a machine with no
     * printer. A level the listing does not have is refused first.
     *
     * @param {number} argBytes
     * @param {number[]} levels
     * @param {number} levelAt     The argument that is the level.
     * @param {number} neededAt    The argument that points at pcbNeeded.
     * @param {number} [environmentAt]  The argument naming an environment, if any.
     * @param {boolean} [wide]
     */
    const listing = (argBytes, levels, levelAt, neededAt, environmentAt, wide = false)=>({
        argBytes,
        /** @param {number[]} args */
        handler: args=>{
            if (environmentAt !== undefined && environmentOf(args[environmentAt], wide) === null)
            {
                return fail(ERROR_INVALID_ENVIRONMENT);
            }
            if (!levels.includes(args[levelAt] >>> 0))
            {
                return fail(ERROR_INVALID_LEVEL);
            }
            const needed = args[neededAt] >>> 0;
            const returned = args[neededAt + 1] >>> 0;
            if (needed === 0 || returned === 0)
            {
                return fail(RPC_X_NULL_REF_POINTER);
            }
            writeDword(needed, 0);
            writeDword(returned, 0);
            host.setLastError?.(ERROR_SUCCESS);
            return TRUE;
        },
    });

    /**
     * A call on a printer, job, form or change-notification handle, none of
     * which exists. Answers FALSE, or for the calls that answer with their
     * error, the error itself.
     *
     * @param {number} argBytes @param {boolean} [errorIsAnswer]
     */
    const onHandle = (argBytes, errorIsAnswer = false)=>({
        argBytes,
        handler: ()=>{
            host.setLastError?.(ERROR_INVALID_HANDLE);
            return errorIsAnswer ? ERROR_INVALID_HANDLE : FALSE;
        },
    });

    /** A call naming a printer, of which there is none by any name. @param {number} argBytes @param {number} [answer] */
    const noPrinter = (argBytes, answer = FALSE)=>({
        argBytes,
        handler: ()=>{
            host.setLastError?.(ERROR_INVALID_PRINTER_NAME);
            return answer;
        },
    });

    /**
     * An installation the user may not make: a level the structure does not
     * have, then a missing structure, then no permission.
     *
     * @param {number} argBytes @param {number[]} levels
     */
    const install = (argBytes, levels)=>({
        argBytes,
        /** @param {number[]} args */
        handler: ([, level, info])=>{
            if (!levels.includes(level >>> 0))
            {
                return fail(ERROR_INVALID_LEVEL);
            }
            return fail((info >>> 0) === 0 ? ERROR_INVALID_PARAMETER : ERROR_ACCESS_DENIED);
        },
    });

    /**
     * A port named for a monitor to add, configure or delete it. No monitor
     * is installed, so no port name is one a monitor answers for; Windows XP
     * says the operation is not supported.
     */
    const portCall = {
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([, , name])=>fail((name >>> 0) === 0 ? RPC_X_NULL_REF_POINTER
            : ERROR_NOT_SUPPORTED),
    };

    /**
     * A removal of something named in an environment: the environment must
     * be one, and then the thing named is not there.
     *
     * @param {number} argBytes @param {number} missing
     */
    const removal = (argBytes, missing)=>({
        argBytes,
        /** @param {number[]} args */
        handler: ([, environment])=>fail(environmentOf(environment, true) === null
            ? ERROR_INVALID_ENVIRONMENT : missing),
    });

    /**
     * GetPrinterDriverDirectory and GetPrintProcessorDirectory: where the
     * spooler keeps its files, which it has with or without a printer. The
     * size is in bytes, terminator included, on success and failure alike.
     *
     * @param {string} root @param {boolean} wide
     */
    const directory = (root, wide)=>({
        argBytes: 24,
        /** @param {number[]} args */
        handler: ([server, environment, level, buffer, size, needed])=>{
            const name = readString(server, wide);
            if (name !== null && name !== '')
            {
                // Another machine's spooler is behind a network this one has not.
                return fail(RPC_S_SERVER_UNAVAILABLE);
            }
            const folder = environmentOf(environment, wide);
            if (folder === null)
            {
                return fail(ERROR_INVALID_ENVIRONMENT);
            }
            if ((level >>> 0) !== 1)
            {
                return fail(ERROR_INVALID_LEVEL);
            }
            if ((needed >>> 0) === 0)
            {
                return fail(RPC_X_NULL_REF_POINTER);
            }
            const path = root + folder;
            const bytes = new Uint8Array((path.length + 1) * (wide ? 2 : 1));
            for (let at = 0; at < path.length; at++)
            {
                bytes[at * (wide ? 2 : 1)] = path.charCodeAt(at);
            }
            writeDword(needed, bytes.length);
            if ((size >>> 0) < bytes.length)
            {
                return fail(ERROR_INSUFFICIENT_BUFFER);
            }
            if ((buffer >>> 0) === 0)
            {
                return fail(ERROR_INVALID_USER_BUFFER);
            }
            host.writeMemory?.(buffer >>> 0, bytes);
            return TRUE;
        },
    });

    /**
     * DeleteMonitor(LPTSTR pName, LPTSTR pEnvironment, LPTSTR pMonitorName):
     * a monitor needs a name, and then there is none by it.
     */
    const deleteMonitor = {
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([, , name])=>fail(readString(name, true) === ''
            ? ERROR_INVALID_PARAMETER : ERROR_UNKNOWN_PRINT_MONITOR),
    };

    /**
     * DeviceCapabilities(LPCTSTR pDevice, LPCTSTR pPort, WORD fwCapability,
     *   LPTSTR pOutput, const DEVMODE *pDevMode): -1 is its failure.
     */
    const deviceCapabilities = noPrinter(20, -1);

    return {
        /** BOOL OpenPrinterA(LPSTR pPrinterName, LPHANDLE phPrinter, LPPRINTER_DEFAULTSA) */
        OpenPrinterA: noPrinter(12),
        /** BOOL OpenPrinterW(LPWSTR, LPHANDLE, LPPRINTER_DEFAULTSW): OpenPrinterA */
        OpenPrinterW: noPrinter(12),

        /** BOOL ClosePrinter(HANDLE hPrinter): no printer was opened to close */
        ClosePrinter: onHandle(4),

        /**
         * LONG DocumentPropertiesA(HWND, HANDLE hPrinter, LPSTR pDeviceName,
         *                          PDEVMODEA out, PDEVMODEA in, DWORD fMode)
         *
         * Negative is the documented failure, since zero and above are sizes.
         */
        DocumentPropertiesA: { argBytes: 24, handler: ()=>-1 },
        DocumentPropertiesW: { argBytes: 24, handler: ()=>-1 },

        /**
         * LONG AdvancedDocumentPropertiesW(HWND, HANDLE hPrinter, LPWSTR pDeviceName,
         *   PDEVMODEW pDevModeOutput, PDEVMODEW pDevModeInput)
         *
         * DocumentProperties with its dialog, and the same negative failure.
         */
        AdvancedDocumentPropertiesW: {
            argBytes: 20,
            handler: ()=>{
                host.setLastError?.(ERROR_INVALID_HANDLE);
                return -1;
            },
        },

        /**
         * BOOL EnumPrinters(DWORD Flags, LPTSTR Name, DWORD Level, LPBYTE,
         *   DWORD cbBuf, LPDWORD pcbNeeded, LPDWORD pcReturned)
         */
        EnumPrintersA: listing(28, [1, 2, 4, 5], 2, 5),
        EnumPrintersW: listing(28, [1, 2, 4, 5], 2, 5),

        /**
         * BOOL EnumPorts(LPTSTR pName, DWORD Level, LPBYTE pPort, DWORD cbBuf,
         *                LPDWORD pcbNeeded, LPDWORD pcReturned)
         *
         * Nothing to print to, so no port to list: none needed, none returned.
         */
        EnumPortsA: listing(24, [1, 2], 1, 4),
        EnumPortsW: listing(24, [1, 2], 1, 4),

        /** BOOL EnumMonitorsW(LPWSTR pName, DWORD Level, LPBYTE, DWORD, LPDWORD, LPDWORD) */
        EnumMonitorsW: listing(24, [1, 2], 1, 4),

        /**
         * BOOL EnumPrintProcessorsW(LPWSTR pName, LPWSTR pEnvironment, DWORD Level,
         *   LPBYTE, DWORD, LPDWORD pcbNeeded, LPDWORD pcReturned)
         */
        EnumPrintProcessorsW: listing(28, [1], 2, 5, 1, true),

        /**
         * BOOL EnumPrinterDriversW(LPWSTR pName, LPWSTR pEnvironment, DWORD Level,
         *   LPBYTE, DWORD, LPDWORD pcbNeeded, LPDWORD pcReturned)
         */
        EnumPrinterDriversW: listing(28, [1, 2, 3, 4, 5, 6, 8], 2, 5, 1, true),

        /**
         * BOOL EnumPrintProcessorDatatypesW(LPWSTR pName, LPWSTR pPrintProcessorName,
         *   DWORD Level, LPBYTE, DWORD, LPDWORD, LPDWORD)
         *
         * Of a print processor, and there is none to name.
         */
        EnumPrintProcessorDatatypesW: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([, , level])=>fail((level >>> 0) !== 1 ? ERROR_INVALID_LEVEL
                : ERROR_UNKNOWN_PRINTPROCESSOR),
        },

        /** BOOL GetPrinterW(HANDLE hPrinter, DWORD Level, LPBYTE, DWORD, LPDWORD) */
        GetPrinterW: onHandle(20),
        /** BOOL SetPrinterW(HANDLE hPrinter, DWORD Level, LPBYTE, DWORD Command) */
        SetPrinterW: onHandle(16),
        /** BOOL DeletePrinter(HANDLE hPrinter) */
        DeletePrinter: onHandle(4),
        /** BOOL ResetPrinterW(HANDLE hPrinter, LPPRINTER_DEFAULTSW) */
        ResetPrinterW: onHandle(8),
        /** BOOL AbortPrinter(HANDLE hPrinter) */
        AbortPrinter: onHandle(4),
        /** DWORD StartDocPrinterW(HANDLE hPrinter, DWORD Level, LPBYTE pDocInfo): 0 is failure */
        StartDocPrinterW: onHandle(12),
        /** BOOL EndDocPrinter(HANDLE hPrinter) */
        EndDocPrinter: onHandle(4),
        /** BOOL StartPagePrinter(HANDLE hPrinter) */
        StartPagePrinter: onHandle(4),
        /** BOOL EndPagePrinter(HANDLE hPrinter) */
        EndPagePrinter: onHandle(4),
        /** BOOL WritePrinter(HANDLE hPrinter, LPVOID pBuf, DWORD cbBuf, LPDWORD pcWritten) */
        WritePrinter: onHandle(16),
        /** BOOL ReadPrinter(HANDLE hPrinter, LPVOID pBuf, DWORD cbBuf, LPDWORD pNoBytesRead) */
        ReadPrinter: onHandle(16),
        /** BOOL GetPrinterDriverW(HANDLE hPrinter, LPWSTR pEnvironment, DWORD Level, ...) */
        GetPrinterDriverW: onHandle(24),
        /** BOOL FindClosePrinterChangeNotification(HANDLE hChange) */
        FindClosePrinterChangeNotification: onHandle(4),

        /** BOOL AddJobW(HANDLE hPrinter, DWORD Level, LPBYTE, DWORD, LPDWORD) */
        AddJobW: onHandle(20),
        /** BOOL ScheduleJob(HANDLE hPrinter, DWORD dwJobID) */
        ScheduleJob: onHandle(8),
        /** BOOL GetJob(HANDLE hPrinter, DWORD JobId, DWORD Level, LPBYTE, DWORD, LPDWORD) */
        GetJobA: onHandle(24),
        GetJobW: onHandle(24),
        /** BOOL SetJobW(HANDLE hPrinter, DWORD JobId, DWORD Level, LPBYTE, DWORD Command) */
        SetJobW: onHandle(20),
        /** BOOL EnumJobsW(HANDLE hPrinter, DWORD FirstJob, DWORD NoJobs, DWORD Level, ...) */
        EnumJobsW: onHandle(32),

        /** BOOL AddFormW(HANDLE hPrinter, DWORD Level, LPBYTE pForm) */
        AddFormW: onHandle(12),
        /** BOOL DeleteFormW(HANDLE hPrinter, LPWSTR pFormName) */
        DeleteFormW: onHandle(8),
        /** BOOL GetFormW(HANDLE hPrinter, LPWSTR pFormName, DWORD Level, LPBYTE, DWORD, LPDWORD) */
        GetFormW: onHandle(24),
        /** BOOL SetFormW(HANDLE hPrinter, LPWSTR pFormName, DWORD Level, LPBYTE pForm) */
        SetFormW: onHandle(16),
        /** BOOL EnumFormsW(HANDLE hPrinter, DWORD Level, LPBYTE, DWORD, LPDWORD, LPDWORD) */
        EnumFormsW: onHandle(24),

        /**
         * The printer-data calls answer with their error, not with a BOOL.
         *
         * DWORD GetPrinterDataW(HANDLE, LPWSTR pValueName, LPDWORD pType, LPBYTE,
         *   DWORD nSize, LPDWORD pcbNeeded)
         */
        GetPrinterDataW: onHandle(24, true),
        /** DWORD GetPrinterDataExW(HANDLE, LPCWSTR pKeyName, LPCWSTR pValueName, ...) */
        GetPrinterDataExW: onHandle(28, true),
        /** DWORD SetPrinterDataW(HANDLE, LPWSTR pValueName, DWORD Type, LPBYTE, DWORD) */
        SetPrinterDataW: onHandle(20, true),
        /** DWORD SetPrinterDataExW(HANDLE, LPCWSTR, LPCWSTR, DWORD Type, LPBYTE, DWORD) */
        SetPrinterDataExW: onHandle(24, true),
        /** DWORD DeletePrinterDataExW(HANDLE, LPCWSTR pKeyName, LPCWSTR pValueName) */
        DeletePrinterDataExW: onHandle(12, true),
        /** DWORD EnumPrinterDataW(HANDLE, DWORD dwIndex, LPWSTR, DWORD, LPDWORD, ...) */
        EnumPrinterDataW: onHandle(36, true),
        /** DWORD EnumPrinterDataExW(HANDLE, LPCWSTR pKeyName, LPBYTE, DWORD, LPDWORD, LPDWORD) */
        EnumPrinterDataExW: onHandle(24, true),
        /** DWORD EnumPrinterKeyW(HANDLE, LPCWSTR pKeyName, LPWSTR, DWORD, LPDWORD) */
        EnumPrinterKeyW: onHandle(20, true),

        /** BOOL AddPrinterConnectionW(LPWSTR pName): no printer, here or shared */
        AddPrinterConnectionW: noPrinter(4),
        /** BOOL DeletePrinterConnectionW(LPWSTR pName) */
        DeletePrinterConnectionW: noPrinter(4),

        DeviceCapabilities: deviceCapabilities,
        DeviceCapabilitiesA: deviceCapabilities,
        DeviceCapabilitiesW: deviceCapabilities,

        /**
         * LONG ExtDeviceMode(HWND, HANDLE hInst, LPDEVMODEA pDevModeOutput,
         *   LPSTR pDeviceName, LPSTR pPort, LPDEVMODEA pDevModeInput,
         *   LPSTR pProfile, DWORD fMode): the old driver entry, failing as
         *   DocumentProperties does.
         */
        ExtDeviceMode: noPrinter(32, -1),

        /**
         * HANDLE ConnectToPrinterDlg(HWND hwnd, DWORD Flags)
         *
         * The browse dialog has no one to choose in it and no network to
         * browse: closed without a printer.
         */
        ConnectToPrinterDlg: {
            argBytes: 8,
            handler: ()=>{
                host.setLastError?.(ERROR_CANCELLED);
                return 0;
            },
        },

        /** BOOL SpoolerInit(void): the spooler is as ready as it will be */
        SpoolerInit: { argBytes: 0, handler: ()=>TRUE },

        /** HANDLE AddPrinterW(LPWSTR pName, DWORD Level, LPBYTE pPrinter): a null handle */
        AddPrinterW: install(12, [2]),
        /** BOOL AddPrinterDriverW(LPWSTR pName, DWORD Level, LPBYTE pDriverInfo) */
        AddPrinterDriverW: install(12, [2, 3, 4, 6]),
        /** BOOL AddPrinterDriverExW(LPWSTR, DWORD Level, LPBYTE, DWORD dwFileCopyFlags) */
        AddPrinterDriverExW: install(16, [2, 3, 4, 6]),
        /** BOOL AddMonitorW(LPWSTR pName, DWORD Level, LPBYTE pMonitors) */
        AddMonitorW: install(12, [2]),
        /** BOOL AddPrintProvidorW(LPWSTR pName, DWORD Level, LPBYTE pProvidorInfo) */
        AddPrintProvidorW: install(12, [1, 2]),
        /**
         * BOOL AddPrintProcessorW(LPWSTR pName, LPWSTR pEnvironment,
         *   LPWSTR pPathName, LPWSTR pPrintProcessorName)
         */
        AddPrintProcessorW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, environment])=>fail(environmentOf(environment, true) === null
                ? ERROR_INVALID_ENVIRONMENT : ERROR_ACCESS_DENIED),
        },
        /** BOOL DeletePrintProvidorW(LPWSTR pName, LPWSTR pEnvironment, LPWSTR pPrintProvidorName) */
        DeletePrintProvidorW: removal(12, ERROR_ACCESS_DENIED),

        /** BOOL AddPortW(LPWSTR pName, HWND hWnd, LPWSTR pMonitorName) */
        AddPortW: portCall,
        /** BOOL ConfigurePortW(LPWSTR pName, HWND hWnd, LPWSTR pPortName) */
        ConfigurePortW: portCall,
        /** BOOL DeletePortW(LPWSTR pName, HWND hWnd, LPWSTR pPortName) */
        DeletePortW: portCall,

        DeleteMonitorW: deleteMonitor,
        /** BOOL DeletePrinterDriverW(LPWSTR pName, LPWSTR pEnvironment, LPWSTR pDriverName) */
        DeletePrinterDriverW: removal(12, ERROR_UNKNOWN_PRINTER_DRIVER),
        /**
         * BOOL DeletePrinterDriverExW(LPWSTR pName, LPWSTR pEnvironment,
         *   LPWSTR pDriverName, DWORD dwDeleteFlag, DWORD dwVersionFlag)
         */
        DeletePrinterDriverExW: removal(20, ERROR_UNKNOWN_PRINTER_DRIVER),
        /** BOOL DeletePrintProcessorW(LPWSTR pName, LPWSTR pEnvironment, LPWSTR pPrintProcessorName) */
        DeletePrintProcessorW: removal(12, ERROR_UNKNOWN_PRINTPROCESSOR),

        /**
         * BOOL GetPrinterDriverDirectory(LPTSTR pName, LPTSTR pEnvironment,
         *   DWORD Level, LPBYTE pDriverDirectory, DWORD cbBuf, LPDWORD pcbNeeded)
         */
        GetPrinterDriverDirectoryA: directory(DRIVER_ROOT, false),
        GetPrinterDriverDirectoryW: directory(DRIVER_ROOT, true),
        /** BOOL GetPrintProcessorDirectory(...): the same shape */
        GetPrintProcessorDirectoryA: directory(PROCESSOR_ROOT, false),
        GetPrintProcessorDirectoryW: directory(PROCESSOR_ROOT, true),
    };
}
