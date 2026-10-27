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
const ERROR_BAD_LENGTH = 24;
const ERROR_MORE_DATA = 234;
const ERROR_NOACCESS = 998;
const ERROR_NO_MORE_FILES = 18;

/** GetFileInformationByHandleEx's classes here, and the fixed ones' sizes. */
const FILE_BASIC_INFO = 0;
const FILE_STANDARD_INFO = 1;
const FILE_NAME_INFO = 2;
const FILE_ATTRIBUTE_TAG_INFO = 9;
const FILE_ID_BOTH_DIRECTORY_INFO = 10;
const FILE_ID_BOTH_DIRECTORY_RESTART_INFO = 11;
const FILE_INFO_SIZES = new Map([
    [FILE_BASIC_INFO, 40], [FILE_STANDARD_INFO, 24], [FILE_ATTRIBUTE_TAG_INFO, 8],
]);

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

/** SYSTEMTIME: eight WORDs, the day of the week third. */
const SYSTEMTIME_SIZE = 16;

/**
 * A SYSTEMTIME's eight words as milliseconds since the Unix epoch, or null
 * when they do not name a moment -- a month or day out of range, an hour past
 * 23 -- which is what SystemTimeToFileTime refuses too.
 *
 * @param {Uint8Array} bytes
 * @returns {number | null}
 */
function systemTimeToMs(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, SYSTEMTIME_SIZE);
    const [year, month, , day, hour, minute, second, millisecond] =
        Array.from({ length: 8 }, (_, at)=>view.getUint16(at * 2, true));
    if (year < 1601 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59
        || second > 59 || millisecond > 999)
    {
        return null;
    }
    const ms = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
    return new Date(ms).getUTCDate() === day ? ms : null;
}

/** @param {number} ms @returns {Uint8Array} the SYSTEMTIME, day of the week filled in */
function msToSystemTime(ms){
    const at = new Date(ms);
    const bytes = new Uint8Array(SYSTEMTIME_SIZE);
    const view = new DataView(bytes.buffer);
    [at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDay(), at.getUTCDate(), at.getUTCHours(),
        at.getUTCMinutes(), at.getUTCSeconds(), at.getUTCMilliseconds()]
        .forEach((value, index)=>view.setUint16(index * 2, value, true));
    return bytes;
}

/**
 * When in a year a zone's transition falls, as milliseconds of its local
 * clock. A SYSTEMTIME with a year is that date; without one it is a rule:
 * wDay is which wDayOfWeek of wMonth, the first to the fourth, and 5 the
 * last one the month has.
 *
 * @param {DataView} rule @param {number} year
 */
function transitionIn(rule, year){
    const word = (/** @type {number} */ index)=>rule.getUint16(index * 2, true);
    const [ruleYear, month, weekday, week, hour, minute, second, millisecond] =
        Array.from({ length: 8 }, (_, at)=>word(at));
    if (ruleYear !== 0)
    {
        return Date.UTC(year, month - 1, week, hour, minute, second, millisecond);
    }
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
    let day = 1 + (weekday - first + 7) % 7 + (Math.min(week, 5) - 1) * 7;
    while (day > length)
    {
        day -= 7;
    }
    return Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
}

/**
 * The minutes a zone's local clock is behind UTC at a moment -- Bias, plus
 * DaylightBias inside daylight time and StandardBias outside it. A zone whose
 * transition months are zero has no daylight time, and then Bias alone is
 * the answer.
 *
 * The daylight transition is written in standard local time and the
 * standard one in daylight local time, the clocks each is read on when it
 * happens; a southern zone's daylight time runs across the new year, and is
 * then the part of the year outside the two.
 *
 * @param {DataView} zone TIME_ZONE_INFORMATION @param {number} utc
 */
function biasAt(zone, utc){
    const bias = zone.getInt32(TIME_ZONE_INFORMATION.Bias, true);
    const standardBias = zone.getInt32(TIME_ZONE_INFORMATION.StandardBias, true);
    const daylightBias = zone.getInt32(TIME_ZONE_INFORMATION.DaylightBias, true);
    const standardRule = new DataView(zone.buffer,
        zone.byteOffset + TIME_ZONE_INFORMATION.StandardDate, SYSTEMTIME_SIZE);
    const daylightRule = new DataView(zone.buffer,
        zone.byteOffset + TIME_ZONE_INFORMATION.DaylightDate, SYSTEMTIME_SIZE);
    if (standardRule.getUint16(2, true) === 0 || daylightRule.getUint16(2, true) === 0)
    {
        return bias;
    }
    const minute = 60_000;
    const year = new Date(utc - (bias + standardBias) * minute).getUTCFullYear();
    const daylightStarts = transitionIn(daylightRule, year) + (bias + standardBias) * minute;
    const daylightEnds = transitionIn(standardRule, year) + (bias + daylightBias) * minute;
    const daylight = daylightStarts < daylightEnds
        ? utc >= daylightStarts && utc < daylightEnds
        : !(utc >= daylightEnds && utc < daylightStarts);
    return bias + (daylight ? daylightBias : standardBias);
}

/**
 * The bias a zone gives a moment on its own clock: the transitions compared
 * as the zone writes them, each on the clock in force just before it.
 *
 * @param {DataView} zone  A TIME_ZONE_INFORMATION.
 * @param {number} local  The wall clock, as milliseconds read as UTC.
 */
function biasOnLocalClock(zone, local){
    const bias = zone.getInt32(TIME_ZONE_INFORMATION.Bias, true);
    const standardBias = zone.getInt32(TIME_ZONE_INFORMATION.StandardBias, true);
    const daylightBias = zone.getInt32(TIME_ZONE_INFORMATION.DaylightBias, true);
    const standardRule = new DataView(zone.buffer,
        zone.byteOffset + TIME_ZONE_INFORMATION.StandardDate, SYSTEMTIME_SIZE);
    const daylightRule = new DataView(zone.buffer,
        zone.byteOffset + TIME_ZONE_INFORMATION.DaylightDate, SYSTEMTIME_SIZE);
    if (standardRule.getUint16(2, true) === 0 || daylightRule.getUint16(2, true) === 0)
    {
        return bias;
    }
    const year = new Date(local).getUTCFullYear();
    const daylightStarts = transitionIn(daylightRule, year);
    const daylightEnds = transitionIn(standardRule, year);
    const daylight = daylightStarts < daylightEnds
        ? local >= daylightStarts && local < daylightEnds
        : !(local >= daylightEnds && local < daylightStarts);
    return bias + (daylight ? daylightBias : standardBias);
}

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
 *                                hidden?: boolean, links?: number,
 *                                identity?: string } | null} stat
 * @property {(path: string, modified: number) => boolean} [setModified]
 *           Stamps a file's write time, in milliseconds since the epoch.
 * @property {(path: string, pattern: string) => { name: string, isDirectory: boolean,
 *     size: number, modified?: number, readOnly?: boolean, hidden?: boolean,
 *     attributes?: number, identity?: string }[]} [list]
 *           A directory's entries, for a listing by handle. Absent, a directory
 *           lists only its dots.
 */

/** FILE_ID_BOTH_DIR_INFO up to its name, and the boundary each entry starts on. */
const ID_BOTH_DIR_FIXED = 104;
const ENTRY_ALIGNMENT = 8;

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

/** The TIME_ZONE_INFORMATION this machine answers with: UTC, no transitions. */
const currentZone = ()=>{
    const data = new Uint8Array(TIME_ZONE_INFORMATION.SIZE);
    data.set(wide('UTC'), TIME_ZONE_INFORMATION.StandardName);
    data.set(wide('UTC'), TIME_ZONE_INFORMATION.DaylightName);
    return data;
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

    /**
     * Where each open directory's listing by handle has got to: the entries
     * taken at its first listing, and the next to give. A restart takes them
     * again.
     *
     * @type {WeakMap<object, { entries: any[], next: number }>}
     */
    const listings = new WeakMap();

    /**
     * GetFileInformationByHandleEx's FileIdBothDirectoryInfo: as many of an
     * open directory's entries as fit, each a FILE_ID_BOTH_DIR_INFO on an
     * eight-byte boundary chained by NextEntryOffset, the last's zero; the
     * next call goes on where this one stopped, and one past the end says
     * ERROR_NO_MORE_FILES. A folder that is not a drive's root lists "." and
     * ".." first, as a find does. No 8.3 names are kept, so ShortName is empty.
     *
     * @param {any} file @param {boolean} restart
     * @param {number} buffer @param {number} room
     */
    const listDirectory = (file, restart, buffer, room)=>{
        if (room === 0)
        {
            return fail(ERROR_BAD_LENGTH);
        }
        if (buffer === 0)
        {
            return fail(ERROR_NOACCESS);
        }
        const holder = host.stat(file.path);
        if (!holder?.isDirectory)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        let listing = listings.get(file);
        if (!listing || restart)
        {
            const dots = /^[A-Za-z]:\\?$/.test(file.path) ? []
                : ['.', '..'].map(name=>({ ...holder, name, isDirectory: true, size: 0 }));
            listing = { entries: [...dots, ...host.list?.(file.path, '*') ?? []], next: 0 };
            listings.set(file, listing);
        }
        if (listing.next >= listing.entries.length)
        {
            return fail(ERROR_NO_MORE_FILES);
        }
        /** @type {{ start: number, record: Uint8Array }[]} */
        const records = [];
        let used = 0;
        for (; listing.next < listing.entries.length; listing.next++)
        {
            const entry = listing.entries[listing.next];
            const start = (used + ENTRY_ALIGNMENT - 1) & ~(ENTRY_ALIGNMENT - 1);
            const length = ID_BOTH_DIR_FIXED + entry.name.length * 2;
            if (start + length > room)
            {
                break;
            }
            const record = new Uint8Array(length);
            const view = new DataView(record.buffer);
            const time = msToFileTime(entry.modified ?? 0);
            for (const at of [8, 16, 24, 32])
            {
                view.setBigUint64(at, time, true);
            }
            const size = BigInt(entry.isDirectory ? 0 : entry.size ?? 0);
            view.setBigUint64(40, size, true);
            view.setBigUint64(48, (size + 4095n) & ~4095n, true);
            view.setUint32(56, fileAttributes(entry), true);
            view.setUint32(60, entry.name.length * 2, true);
            const own = entry.name === '.' ? file.path
                : entry.name === '..' ? file.path.replace(/\\[^\\]*$/, '')
                    : `${file.path}\\${entry.name}`;
            view.setUint32(96, fileIndex(entry.identity ?? own), true);
            [...entry.name].forEach((unit, at)=>view.setUint16(ID_BOTH_DIR_FIXED + at * 2,
                unit.charCodeAt(0), true));
            records.push({ start, record });
            used = start + length;
        }
        if (records.length === 0)
        {
            return fail(ERROR_MORE_DATA);
        }
        records.forEach(({ start, record }, index)=>{
            const after = records[index + 1];
            new DataView(record.buffer).setUint32(0, after ? after.start - start : 0, true);
            host.writeMemory(buffer + start, record);
        });
        return 1;
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
                const index = fileIndex(entry?.identity ?? file.path);

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
                view.setUint32(BY_HANDLE_FILE_INFORMATION.nNumberOfLinks, entry?.links ?? 1, true);
                view.setUint32(BY_HANDLE_FILE_INFORMATION.nFileIndexLow, index, true);
                host.writeMemory(information >>> 0, data);
                return 1;
            },
        },

        /**
         * BOOL GetFileInformationByHandleEx(HANDLE hFile,
         *   FILE_INFO_BY_HANDLE_CLASS FileInformationClass, LPVOID lpFileInformation,
         *   DWORD dwBufferSize)
         *
         * The four classes a program reads about an open file: its times and
         * attributes, its sizes and kind, its name below the drive, and its
         * attributes with no reparse tag. A name too long for the buffer gives
         * its length and what fits, with ERROR_MORE_DATA; any other class is
         * refused.
         */
        GetFileInformationByHandleEx: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, kind, buffer, size])=>{
                const file = object(handle, 'file');
                if (!file)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if ((kind >>> 0) === FILE_ID_BOTH_DIRECTORY_INFO
                    || (kind >>> 0) === FILE_ID_BOTH_DIRECTORY_RESTART_INFO)
                {
                    return listDirectory(file, (kind >>> 0) === FILE_ID_BOTH_DIRECTORY_RESTART_INFO,
                        buffer >>> 0, size >>> 0);
                }
                const entry = host.stat(file.path);
                const room = size >>> 0;
                const at = buffer >>> 0;
                if ((kind >>> 0) === FILE_NAME_INFO)
                {
                    const name = String(file.path).replace(/^[A-Za-z]:/, '');
                    const bytes = new Uint8Array(4 + name.length * 2);
                    const view = new DataView(bytes.buffer);
                    view.setUint32(0, name.length * 2, true);
                    [...name].forEach((character, index)=>
                        view.setUint16(4 + index * 2, character.charCodeAt(0), true));
                    if (room < 4 || at === 0)
                    {
                        return fail(ERROR_BAD_LENGTH);
                    }
                    host.writeMemory(at, bytes.subarray(0, Math.min(room, bytes.length)));
                    return room < bytes.length ? fail(ERROR_MORE_DATA) : 1;
                }
                const layout = FILE_INFO_SIZES.get(kind >>> 0);
                if (layout === undefined)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if (room < layout || at === 0)
                {
                    return fail(ERROR_BAD_LENGTH);
                }
                const bytes = new Uint8Array(layout);
                const view = new DataView(bytes.buffer);
                const attributes = fileAttributes(entry);
                if ((kind >>> 0) === FILE_BASIC_INFO)
                {
                    const time = msToFileTime(entry?.modified ?? 0);
                    for (const offset of [0, 8, 16, 24])
                    {
                        view.setBigUint64(offset, time, true);
                    }
                    view.setUint32(32, attributes, true);
                }
                else if ((kind >>> 0) === FILE_STANDARD_INFO)
                {
                    const length = BigInt(entry?.size ?? 0);
                    view.setBigUint64(0, (length + 4095n) & ~4095n, true);
                    view.setBigUint64(8, length, true);
                    view.setUint32(16, 1, true);
                    bytes[21] = (attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0 ? 1 : 0;
                }
                else
                {
                    view.setUint32(0, attributes, true);
                }
                host.writeMemory(at, bytes);
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
                host.writeMemory(information >>> 0, currentZone());
                return TIME_ZONE_ID_UNKNOWN;
            },
        },

        /**
         * BOOL SystemTimeToTzSpecificLocalTime(
         *   const TIME_ZONE_INFORMATION *lpTimeZoneInformation,
         *   const SYSTEMTIME *lpUniversalTime, LPSYSTEMTIME lpLocalTime)
         *
         * A NULL zone is this machine's, the one GetTimeZoneInformation
         * reports -- UTC, so the time comes back as it went in. A zone the caller
         * describes is applied with its own daylight rules. The day of the
         * week is computed afresh, as the conversion through a FILETIME does.
         */
        SystemTimeToTzSpecificLocalTime: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([zone, universal, local])=>{
                if (universal === 0 || local === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const utc = systemTimeToMs(host.readMemory(universal >>> 0, SYSTEMTIME_SIZE));
                if (utc === null)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const data = zone === 0
                    ? currentZone()
                    : host.readMemory(zone >>> 0, TIME_ZONE_INFORMATION.SIZE).slice();
                const bias = biasAt(new DataView(data.buffer), utc);
                host.writeMemory(local >>> 0, msToSystemTime(utc - bias * 60_000));
                return 1;
            },
        },

        /**
         * BOOL TzSpecificLocalTimeToSystemTime(
         *   const TIME_ZONE_INFORMATION *lpTimeZoneInformation,
         *   const SYSTEMTIME *lpLocalTime, LPSYSTEMTIME lpUniversalTime)
         *
         * The way back. Which bias applies is read off the local clock, as
         * the zone's rules are written: daylight from the daylight date's hour
         * on the standard clock until the standard date's hour on the daylight
         * clock. So the hour the clock repeats in autumn is taken as daylight
         * time, and the hour it skips in spring as daylight time too, as
         * Windows takes them (kernel32's time tests pin both).
         */
        TzSpecificLocalTimeToSystemTime: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([zone, local, universal])=>{
                if (local === 0 || universal === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const wall = systemTimeToMs(host.readMemory(local >>> 0, SYSTEMTIME_SIZE));
                if (wall === null)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const data = zone === 0
                    ? currentZone()
                    : host.readMemory(zone >>> 0, TIME_ZONE_INFORMATION.SIZE).slice();
                const bias = biasOnLocalClock(new DataView(data.buffer), wall);
                host.writeMemory(universal >>> 0, msToSystemTime(wall + bias * 60_000));
                return 1;
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
export function fileIndex(path){
    let hash = 2166136261;
    const text = path.toLowerCase();
    for (let at = 0; at < text.length; at++)
    {
        hash ^= text.charCodeAt(at);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}
