/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * When a file was touched, and what timezone the machine believes it is in.
 *
 * One decision runs through the whole file and is worth stating once: **this
 * machine is in UTC and has no daylight saving.** So the two conversions
 * between file time and local file time are the identity, and the timezone
 * report says a bias of zero with no transition dates.
 *
 * That is a choice, not an oversight. A program timestamps a save with one
 * clock and reads it back with another, and any offset invented here would make
 * those two disagree -- a file saved "in the future", a cache that always looks
 * stale. There is no user-visible clock in this build to be wrong about, so the
 * consistent answer is the useful one.
 *
 * File times themselves are real where the filesystem knows them and zero where
 * it does not. Zero is meaningful: it is what Windows reports for a file whose
 * time was never recorded, and a program that sorts by it gets a stable order
 * rather than an invented one.
 */

/** Codes this surface reports. */
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;

/** What GetTimeZoneInformation answers: this machine is not in daylight time. */
const TIME_ZONE_ID_UNKNOWN = 0;

/**
 * BY_HANDLE_FILE_INFORMATION, laid out the way the guest compiled it.
 *
 * The three FILETIMEs are eight bytes each, so nothing after the attributes is
 * where a field count would put it -- a size read from the wrong offset comes
 * back as a plausible number rather than as an error.
 */
export const BY_HANDLE_FILE_INFORMATION = Object.freeze({
    dwFileAttributes: 0,
    ftCreationTime: 4,
    ftLastAccessTime: 12,
    ftLastWriteTime: 20,
    dwVolumeSerialNumber: 28,
    nFileSizeHigh: 32,
    nFileSizeLow: 36,
    nNumberOfLinks: 40,
    nFileIndexHigh: 44,
    nFileIndexLow: 48,
    SIZE: 52,
});

/**
 * TIME_ZONE_INFORMATION. The two names are WCHAR[32] -- 64 bytes each, not 32 --
 * which is the offset most often got wrong here and puts every field after
 * StandardName in the wrong place.
 */
export const TIME_ZONE_INFORMATION = Object.freeze({
    Bias: 0,
    StandardName: 4,
    StandardDate: 68,
    StandardBias: 84,
    DaylightName: 88,
    DaylightDate: 152,
    DaylightBias: 168,
    SIZE: 172,
});

/** The volume every file here reports belonging to. */
const VOLUME_SERIAL = 0xb0771f42;

/** FILETIME units (100 ns) between 1601-01-01 and the Unix epoch. */
const FILETIME_EPOCH = 116_444_736_000_000_000n;
/** FILETIME units in one millisecond. */
const FILETIME_PER_MS = 10_000n;

/**
 * Milliseconds since the Unix epoch as a FILETIME. A moment before 1970 is
 * still after 1601, so nothing here goes negative for the dates a file has.
 *
 * @param {number} ms
 * @returns {bigint}
 */
export function msToFileTime(ms){
    return BigInt(Math.floor(ms)) * FILETIME_PER_MS + FILETIME_EPOCH;
}

/**
 * The reverse, or null for a FILETIME before the Unix epoch -- which is what
 * an uninitialised one reads as.
 *
 * @param {bigint} units
 * @returns {number | null}
 */
export function fileTimeToMs(units){
    return units < FILETIME_EPOCH ? null : Number((units - FILETIME_EPOCH) / FILETIME_PER_MS);
}
/** The DOS calendar runs from 1980 to 2107, in two-second steps. */
const DOS_FIRST_MS = Date.UTC(1980, 0, 1);
const DOS_LAST_MS = Date.UTC(2107, 11, 31, 23, 59, 58);

/**
 * A DOS date and time -- the packed words an archive of the era stores for
 * every member -- as milliseconds since the Unix epoch, or null when the
 * words do not name a date. Local time on the machine that packed it, which
 * this machine treats as UTC, as it treats every local time.
 *
 * @param {number} date @param {number} time
 * @returns {number | null}
 */
export function dosDateTimeToMs(date, time){
    const year = 1980 + (date >>> 9);
    const month = (date >>> 5) & 0xf;
    const day = date & 0x1f;
    const hours = time >>> 11;
    const minutes = (time >>> 5) & 0x3f;
    const seconds = (time & 0x1f) * 2;
    if (month < 1 || month > 12 || day < 1 || hours > 23 || minutes > 59 || seconds > 59)
    {
        return null;
    }
    const ms = Date.UTC(year, month - 1, day, hours, minutes, seconds);
    // A day past the month's end rolls over in Date.UTC; DOS refuses it.
    return new Date(ms).getUTCDate() === day ? ms : null;
}

/**
 * The reverse: the two words for a moment, or null when the moment is
 * outside the calendar DOS can write. Seconds round down to the even one.
 *
 * @param {number} ms
 * @returns {{ date: number, time: number } | null}
 */
export function msToDosDateTime(ms){
    if (!(ms >= DOS_FIRST_MS && ms <= DOS_LAST_MS))
    {
        return null;
    }
    const at = new Date(ms);
    return {
        date: ((at.getUTCFullYear() - 1980) << 9) | ((at.getUTCMonth() + 1) << 5)
            | at.getUTCDate(),
        time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5)
            | (at.getUTCSeconds() >>> 1),
    };
}

const FILE_ATTRIBUTE_READONLY = 0x01;
const FILE_ATTRIBUTE_HIDDEN = 0x02;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_ARCHIVE = 0x20;
const FILE_ATTRIBUTE_NORMAL = 0x80;

/**
 * The attributes a name on the volume is reported with.
 *
 * A name nobody set attributes on is an ordinary archived file or a plain
 * directory -- except on read-only media, where every name is read-only, files
 * and directories alike, as the CD-ROM file system reports them, and none
 * carries the archive bit, because nothing ever wrote it. A name the disc
 * records as hidden is hidden.
 *
 * Attributes a program set are what it set, the directory bit beside them.
 * FILE_ATTRIBUTE_NORMAL means "no other attribute" and is only ever answered
 * alone: a directory set to it is just a directory.
 *
 * @param {{ isDirectory: boolean, readOnly?: boolean, hidden?: boolean,
 *           attributes?: number } | null | undefined} entry
 * @returns {number}
 */
export function fileAttributes(entry){
    const kind = entry?.isDirectory ? FILE_ATTRIBUTE_DIRECTORY : 0;
    const hidden = entry?.hidden ? FILE_ATTRIBUTE_HIDDEN : 0;
    const media = entry?.readOnly ? FILE_ATTRIBUTE_READONLY : 0;
    if (entry?.attributes !== undefined)
    {
        const bits = (entry.attributes | kind | hidden | media) >>> 0;
        const others = bits & ~FILE_ATTRIBUTE_NORMAL;
        return others !== 0 ? others : FILE_ATTRIBUTE_NORMAL;
    }
    if (media !== 0)
    {
        return kind | hidden | media;
    }
    return (kind || FILE_ATTRIBUTE_ARCHIVE) | hidden;
}

/**
 * @typedef {Object} FileTimeHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(code: number) => void} setLastError
 * @property {(handle: number, type?: string) => any} resolveHandle
 * @property {(path: string) => { exists: boolean, isDirectory: boolean,
 *                                size: number, modified?: number, readOnly?: boolean,
 *                                hidden?: boolean } | null} stat
 * @property {(path: string, modified: number) => boolean} [setModified]
 *           Stamps a file's write time, in milliseconds since the epoch.
 */

/** @param {string} text @returns {Uint8Array} UTF-16, NUL-terminated. */
const wide = text=>{
    const bytes = new Uint8Array((text.length + 1) * 2);
    for (let at = 0; at < text.length; at++)
    {
        const code = text.charCodeAt(at);
        bytes[at * 2] = code & 0xff;
        bytes[at * 2 + 1] = code >> 8;
    }
    return bytes;
};

/**
 * @param {FileTimeHost} host
 */
export function createFileTimeFunctions(host){
    /** @param {number} handle @param {string} [type] */
    const object = (handle, type)=>{
        try
        {
            return host.resolveHandle(handle >>> 0, type);
        }
        catch (e){
            void e;
            return null;
        }
    };

    /** @param {number} code @param {number} [result] */
    const fail = (code, result = 0)=>{
        host.setLastError(code);
        return result;
    };

    /** @param {number} address @returns {bigint} */
    const readFileTime = address=>{
        const bytes = host.readMemory(address, 8);
        return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
    };

    /** @param {number} address @param {bigint} value */
    const writeFileTime = (address, value)=>{
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigUint64(0, value, true);
        host.writeMemory(address, bytes);
    };

    /**
     * A file's recorded times, in FILETIME units. The volume keeps one time
     * per file -- when it was last written -- and that is what all three
     * answer with: a program comparing dates compares the write time, and a
     * creation time later than it would be a contradiction.
     *
     * @param {any} file
     */
    const timesOf = file=>{
        const written = msToFileTime(host.stat(file.path)?.modified ?? 0);
        return { created: written, accessed: written, written };
    };

    return {
        /**
         * BOOL FileTimeToLocalFileTime(const FILETIME *lpFileTime,
         *                              LPFILETIME lpLocalFileTime)
         *
         * The identity, because this machine is in UTC. Still a real function:
         * a caller checks the return value, and the two pointers may differ.
         */
        FileTimeToLocalFileTime: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([from, to])=>{
                if (from === 0 || to === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                writeFileTime(to >>> 0, readFileTime(from >>> 0));
                return 1;
            },
        },

        /**
         * BOOL DosDateTimeToFileTime(WORD wFatDate, WORD wFatTime, LPFILETIME)
         *
         * What an installer calls for every file it unpacks: the archive
         * carries DOS words, the file it writes wants a FILETIME, and the
         * file's recorded time is what its next pass compares against to
         * decide whether the copy is done.
         */
        DosDateTimeToFileTime: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([date, time, out])=>{
                const ms = dosDateTimeToMs(date & 0xffff, time & 0xffff);
                if (ms === null || out === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                writeFileTime(out >>> 0, BigInt(ms) * FILETIME_PER_MS + FILETIME_EPOCH);
                return 1;
            },
        },

        /** BOOL FileTimeToDosDateTime(const FILETIME *, LPWORD lpFatDate, LPWORD lpFatTime) */
        FileTimeToDosDateTime: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([from, outDate, outTime])=>{
                if (from === 0 || outDate === 0 || outTime === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const units = readFileTime(from >>> 0);
                const packed = units < FILETIME_EPOCH
                    ? null
                    : msToDosDateTime(Number((units - FILETIME_EPOCH) / FILETIME_PER_MS));
                if (packed === null)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const word = (/** @type {number} */ value)=>
                    new Uint8Array([value & 0xff, value >>> 8]);
                host.writeMemory(outDate >>> 0, word(packed.date));
                host.writeMemory(outTime >>> 0, word(packed.time));
                return 1;
            },
        },

        /** BOOL LocalFileTimeToFileTime(const FILETIME *, LPFILETIME) */
        LocalFileTimeToFileTime: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([from, to])=>{
                if (from === 0 || to === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                writeFileTime(to >>> 0, readFileTime(from >>> 0));
                return 1;
            },
        },

        /**
         * BOOL GetFileTime(HANDLE hFile, LPFILETIME lpCreationTime,
         *   LPFILETIME lpLastAccessTime, LPFILETIME lpLastWriteTime)
         *
         * All three pointers are optional and a NULL one is not an error, which
         * is how a program asks for only the write time -- the usual case.
         */
        GetFileTime: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, created, accessed, written])=>{
                const file = object(handle, 'file');
                if (!file)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const times = timesOf(file);
                for (const [address, value] of /** @type {[number, bigint][]} */ ([
                    [created >>> 0, times.created],
                    [accessed >>> 0, times.accessed],
                    [written >>> 0, times.written],
                ]))
                {
                    if (address !== 0)
                    {
                        writeFileTime(address, value);
                    }
                }
                return 1;
            },
        },

        /**
         * BOOL SetFileTime(HANDLE hFile, const FILETIME *, const FILETIME *,
         *                  const FILETIME *)
         *
         * The write time is kept; the other two are accepted, since the
         * volume records one time per file and the write time is the one a
         * program compares. An installer stamps every file it unpacks with
         * the archive's time and, on its next pass, copies again anything
         * whose time does not match -- so a time that was not kept is a
         * file that is installed forever.
         */
        SetFileTime: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, , , written])=>{
                const file = object(handle, 'file');
                if (!file)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if ((written >>> 0) !== 0)
                {
                    const ms = fileTimeToMs(readFileTime(written >>> 0));
                    if (ms !== null)
                    {
                        host.setModified?.(file.path, ms);
                    }
                }
                return 1;
            },
        },

        /**
         * BOOL GetFileInformationByHandle(HANDLE hFile,
         *   LPBY_HANDLE_FILE_INFORMATION lpFileInformation)
         *
         * Written in one piece so no field is left holding whatever the caller's
         * buffer had in it. The file index is derived from the path rather than
         * invented per call: a program compares two indices to decide whether
         * two handles name one file, and a fresh number each time makes every
         * comparison say no.
         */
        GetFileInformationByHandle: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, information])=>{
                const file = object(handle, 'file');
                if (!file)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if (information === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const entry = host.stat(file.path);
                const size = entry?.size ?? 0;
                const index = fileIndex(file.path);

                const data = new Uint8Array(BY_HANDLE_FILE_INFORMATION.SIZE);
                const view = new DataView(data.buffer);
                view.setUint32(BY_HANDLE_FILE_INFORMATION.dwFileAttributes,
                    fileAttributes(entry), true);
                const time = msToFileTime(entry?.modified ?? 0);
                view.setBigUint64(BY_HANDLE_FILE_INFORMATION.ftCreationTime, time, true);
                view.setBigUint64(BY_HANDLE_FILE_INFORMATION.ftLastAccessTime, time, true);
                view.setBigUint64(BY_HANDLE_FILE_INFORMATION.ftLastWriteTime, time, true);
                view.setUint32(BY_HANDLE_FILE_INFORMATION.dwVolumeSerialNumber,
                    VOLUME_SERIAL, true);
                view.setUint32(BY_HANDLE_FILE_INFORMATION.nFileSizeHigh,
                    Math.floor(size / 0x100000000) >>> 0, true);
                view.setUint32(BY_HANDLE_FILE_INFORMATION.nFileSizeLow, size >>> 0, true);
                view.setUint32(BY_HANDLE_FILE_INFORMATION.nNumberOfLinks, 1, true);
                view.setUint32(BY_HANDLE_FILE_INFORMATION.nFileIndexLow, index, true);
                host.writeMemory(information >>> 0, data);
                return 1;
            },
        },

        /**
         * BOOL SetLocalTime(const SYSTEMTIME *lpSystemTime)
         *
         * Refused. The clock is the guest's own and is what every timestamp and
         * every elapsed-time measurement in the run is taken against; letting a
         * program move it would make a measurement that spans the call
         * meaningless, and there is no user whose wall clock this would be.
         */
        SetLocalTime: {
            argBytes: 4,
            handler: ()=>fail(ERROR_INVALID_PARAMETER),
        },

        /**
         * DWORD GetTimeZoneInformation(LPTIME_ZONE_INFORMATION lpTimeZoneInformation)
         *
         * TIME_ZONE_ID_UNKNOWN with a zero bias: this machine is in UTC and
         * observes no daylight saving. Reporting a transition would make the
         * conversions above wrong twice a year.
         */
        GetTimeZoneInformation: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([information])=>{
                if (information === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER, 0xffffffff);
                }
                const data = new Uint8Array(TIME_ZONE_INFORMATION.SIZE);
                data.set(wide('UTC'), TIME_ZONE_INFORMATION.StandardName);
                data.set(wide('UTC'), TIME_ZONE_INFORMATION.DaylightName);
                host.writeMemory(information >>> 0, data);
                return TIME_ZONE_ID_UNKNOWN;
            },
        },
    };
}

/**
 * A stable file index for a path.
 *
 * Windows takes this from the filesystem's own record. There is no such record
 * here, so it is derived from the path -- which gives the one property a caller
 * actually uses: two handles onto the same file report the same index, and two
 * different files almost never do.
 *
 * @param {string} path
 */
function fileIndex(path){
    let hash = 2166136261;
    const text = path.toLowerCase();
    for (let at = 0; at < text.length; at++)
    {
        hash ^= text.charCodeAt(at);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}
