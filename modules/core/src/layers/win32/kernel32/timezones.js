/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Windows' time zones, the ones GetTimeZoneInformationForYear and
 * EnumDynamicTimeZoneInformation name by their registry key, and what each
 * of them is in a given year.
 *
 * The machine itself stays in UTC (`filetime.js`); these are the zones a
 * program asks about by name. Their rules are not carried here: each key is
 * paired with the IANA zone CLDR maps it to, and a year's offsets and
 * transitions are read from the platform's own zone data through Intl --
 * which is also what keeps a year's answer current as the rules change.
 *
 * Windows writes a year's rules as one standard and one daylight period,
 * and the shapes are its: two offsets in a year make the smaller one standard
 * and the larger daylight, from the first change into daylight to the last
 * change out of it; a year whose one change moves the zone for good makes
 * the new offset standard and the old one "daylight" from 1 January. A change
 * at local midnight is written as the last millisecond of the day before.
 */

/** CLDR's windowsZones.xml, its territory "001" rows: Windows key, then IANA zone. */
const WINDOWS_ZONES = [
    'Dateline Standard Time|Etc/GMT+12', 'UTC-11|Etc/GMT+11',
    'Aleutian Standard Time|America/Adak', 'Hawaiian Standard Time|Pacific/Honolulu',
    'Marquesas Standard Time|Pacific/Marquesas', 'Alaskan Standard Time|America/Anchorage',
    'UTC-09|Etc/GMT+9', 'Pacific Standard Time (Mexico)|America/Tijuana', 'UTC-08|Etc/GMT+8',
    'Pacific Standard Time|America/Los_Angeles', 'US Mountain Standard Time|America/Phoenix',
    'Mountain Standard Time (Mexico)|America/Mazatlan', 'Mountain Standard Time|America/Denver',
    'British Columbia Standard Time|America/Vancouver', 'Yukon Standard Time|America/Whitehorse',
    'Alberta Standard Time|America/Edmonton', 'Central America Standard Time|America/Guatemala',
    'Central Standard Time|America/Chicago', 'Easter Island Standard Time|Pacific/Easter',
    'Central Standard Time (Mexico)|America/Mexico_City',
    'Canada Central Standard Time|America/Regina', 'Manitoba Standard Time|America/Winnipeg',
    'SA Pacific Standard Time|America/Bogota', 'Eastern Standard Time (Mexico)|America/Cancun',
    'Eastern Standard Time|America/New_York', 'Haiti Standard Time|America/Port-au-Prince',
    'Cuba Standard Time|America/Havana', 'US Eastern Standard Time|America/Indianapolis',
    'Turks And Caicos Standard Time|America/Grand_Turk', 'Paraguay Standard Time|America/Asuncion',
    'Atlantic Standard Time|America/Halifax', 'Venezuela Standard Time|America/Caracas',
    'Central Brazilian Standard Time|America/Cuiaba', 'SA Western Standard Time|America/La_Paz',
    'Pacific SA Standard Time|America/Santiago', 'Newfoundland Standard Time|America/St_Johns',
    'Tocantins Standard Time|America/Araguaina',
    'E. South America Standard Time|America/Sao_Paulo', 'SA Eastern Standard Time|America/Cayenne',
    'Argentina Standard Time|America/Buenos_Aires', 'Greenland Standard Time|America/Godthab',
    'Montevideo Standard Time|America/Montevideo', 'Magallanes Standard Time|America/Punta_Arenas',
    'Saint Pierre Standard Time|America/Miquelon', 'Bahia Standard Time|America/Bahia',
    'UTC-02|Etc/GMT+2', 'Azores Standard Time|Atlantic/Azores',
    'Cape Verde Standard Time|Atlantic/Cape_Verde', 'UTC|Etc/UTC',
    'GMT Standard Time|Europe/London', 'Greenwich Standard Time|Atlantic/Reykjavik',
    'Sao Tome Standard Time|Africa/Sao_Tome', 'Morocco Standard Time|Africa/Casablanca',
    'W. Europe Standard Time|Europe/Berlin', 'Central Europe Standard Time|Europe/Budapest',
    'Romance Standard Time|Europe/Paris', 'Central European Standard Time|Europe/Warsaw',
    'W. Central Africa Standard Time|Africa/Lagos', 'Jordan Standard Time|Asia/Amman',
    'GTB Standard Time|Europe/Bucharest', 'Middle East Standard Time|Asia/Beirut',
    'Egypt Standard Time|Africa/Cairo', 'E. Europe Standard Time|Europe/Chisinau',
    'Syria Standard Time|Asia/Damascus', 'West Bank Standard Time|Asia/Hebron',
    'South Africa Standard Time|Africa/Johannesburg', 'FLE Standard Time|Europe/Kiev',
    'Israel Standard Time|Asia/Jerusalem', 'South Sudan Standard Time|Africa/Juba',
    'Kaliningrad Standard Time|Europe/Kaliningrad', 'Sudan Standard Time|Africa/Khartoum',
    'Libya Standard Time|Africa/Tripoli', 'Namibia Standard Time|Africa/Windhoek',
    'Arabic Standard Time|Asia/Baghdad', 'Turkey Standard Time|Europe/Istanbul',
    'Arab Standard Time|Asia/Riyadh', 'Belarus Standard Time|Europe/Minsk',
    'Russian Standard Time|Europe/Moscow', 'E. Africa Standard Time|Africa/Nairobi',
    'Iran Standard Time|Asia/Tehran', 'Arabian Standard Time|Asia/Dubai',
    'Astrakhan Standard Time|Europe/Astrakhan', 'Azerbaijan Standard Time|Asia/Baku',
    'Russia Time Zone 3|Europe/Samara', 'Mauritius Standard Time|Indian/Mauritius',
    'Saratov Standard Time|Europe/Saratov', 'Georgian Standard Time|Asia/Tbilisi',
    'Volgograd Standard Time|Europe/Volgograd', 'Caucasus Standard Time|Asia/Yerevan',
    'Afghanistan Standard Time|Asia/Kabul', 'West Asia Standard Time|Asia/Tashkent',
    'Ekaterinburg Standard Time|Asia/Yekaterinburg', 'Pakistan Standard Time|Asia/Karachi',
    'Qyzylorda Standard Time|Asia/Qyzylorda', 'India Standard Time|Asia/Calcutta',
    'Sri Lanka Standard Time|Asia/Colombo', 'Nepal Standard Time|Asia/Katmandu',
    'Central Asia Standard Time|Asia/Bishkek', 'Bangladesh Standard Time|Asia/Dhaka',
    'Omsk Standard Time|Asia/Omsk', 'Myanmar Standard Time|Asia/Rangoon',
    'SE Asia Standard Time|Asia/Bangkok', 'Altai Standard Time|Asia/Barnaul',
    'W. Mongolia Standard Time|Asia/Hovd', 'North Asia Standard Time|Asia/Krasnoyarsk',
    'N. Central Asia Standard Time|Asia/Novosibirsk', 'Tomsk Standard Time|Asia/Tomsk',
    'China Standard Time|Asia/Shanghai', 'North Asia East Standard Time|Asia/Irkutsk',
    'Singapore Standard Time|Asia/Singapore', 'W. Australia Standard Time|Australia/Perth',
    'Taipei Standard Time|Asia/Taipei', 'Ulaanbaatar Standard Time|Asia/Ulaanbaatar',
    'Aus Central W. Standard Time|Australia/Eucla', 'Transbaikal Standard Time|Asia/Chita',
    'Tokyo Standard Time|Asia/Tokyo', 'North Korea Standard Time|Asia/Pyongyang',
    'Korea Standard Time|Asia/Seoul', 'Yakutsk Standard Time|Asia/Yakutsk',
    'Cen. Australia Standard Time|Australia/Adelaide',
    'AUS Central Standard Time|Australia/Darwin', 'E. Australia Standard Time|Australia/Brisbane',
    'AUS Eastern Standard Time|Australia/Sydney',
    'West Pacific Standard Time|Pacific/Port_Moresby', 'Tasmania Standard Time|Australia/Hobart',
    'Vladivostok Standard Time|Asia/Vladivostok', 'Lord Howe Standard Time|Australia/Lord_Howe',
    'Bougainville Standard Time|Pacific/Bougainville', 'Russia Time Zone 10|Asia/Srednekolymsk',
    'Magadan Standard Time|Asia/Magadan', 'Norfolk Standard Time|Pacific/Norfolk',
    'Sakhalin Standard Time|Asia/Sakhalin', 'Central Pacific Standard Time|Pacific/Guadalcanal',
    'Russia Time Zone 11|Asia/Kamchatka', 'New Zealand Standard Time|Pacific/Auckland',
    'UTC+12|Etc/GMT-12', 'Fiji Standard Time|Pacific/Fiji',
    'Chatham Islands Standard Time|Pacific/Chatham', 'UTC+13|Etc/GMT-13',
    'Tonga Standard Time|Pacific/Tongatapu', 'Samoa Standard Time|Pacific/Apia',
    'Line Islands Standard Time|Pacific/Kiritimati',
];

/** @type {ReadonlyMap<string, string>} */
const IANA = new Map(WINDOWS_ZONES.map(row=>/** @type {[string, string]} */ (row.split('|'))));

/** The keys as the registry lists them, which EnumDynamicTimeZoneInformation walks. */
export const ZONE_KEYS = Object.freeze([...IANA.keys()].sort((a, b)=>(a < b ? -1 : a > b ? 1 : 0)));

/** TIME_ZONE_INFORMATION's fields and size. */
const TZI = Object.freeze({
    Bias: 0, StandardName: 4, StandardDate: 68, StandardBias: 84,
    DaylightName: 88, DaylightDate: 152, DaylightBias: 168, SIZE: 172,
});

const MINUTE = 60_000;
const DAY = 86_400_000;

/** @type {Map<string, Intl.DateTimeFormat>} */
const formats = new Map();

/**
 * A zone's offset from UTC at a moment, in minutes east.
 *
 * @param {string} zone @param {number} ms
 */
function offsetAt(zone, ms){
    let format = formats.get(zone);
    if (format === undefined)
    {
        format = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' });
        formats.set(zone, format);
    }
    const name = format.formatToParts(ms).find(part=>part.type === 'timeZoneName')?.value ?? '';
    const match = /GMT([+-])(\d\d):(\d\d)/.exec(name);
    if (match === null)
    {
        return 0;
    }
    return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

/**
 * The changes of offset a zone makes in a year, each as the moment and the
 * offsets before and after, and the offset the year starts in.
 *
 * @param {string} zone @param {number} year
 */
function changesIn(zone, year){
    const newYear = Date.UTC(year, 0, 1);
    const first = offsetAt(zone, newYear - offsetAt(zone, newYear) * MINUTE);
    const start = newYear - first * MINUTE;
    const end = Date.UTC(year + 1, 0, 1) - offsetAt(zone, Date.UTC(year + 1, 0, 1)) * MINUTE;
    const step = DAY / 4;
    /** @type {{ at: number, before: number, after: number }[]} */
    const changes = [];
    let current = first;
    for (let from = start; from < end; from += step)
    {
        const next = offsetAt(zone, Math.min(from + step, end - 1));
        if (next === current)
        {
            continue;
        }
        let low = from;
        let high = Math.min(from + step, end - 1);
        while (high - low > MINUTE)
        {
            const middle = Math.floor((low + high) / 2 / MINUTE) * MINUTE;
            if (offsetAt(zone, middle) === current)
            {
                low = middle;
            }
            else
            {
                high = middle;
            }
        }
        changes.push({ at: high, before: current, after: next });
        current = next;
    }
    return { first, changes };
}

/** @param {DataView} view @param {number} offset @param {string} text */
function putName(view, offset, text){
    for (let at = 0; at < Math.min(text.length, 31); at++)
    {
        view.setUint16(offset + at * 2, text.charCodeAt(at), true);
    }
}

/**
 * A SYSTEMTIME of a date in the year, as a zone's local clock read it.
 *
 * @param {DataView} view @param {number} offset @param {number} local  ms of the local clock.
 */
function putDate(view, offset, local){
    const when = new Date(local);
    [when.getUTCFullYear(), when.getUTCMonth() + 1, when.getUTCDay(), when.getUTCDate(),
        when.getUTCHours(), when.getUTCMinutes(), when.getUTCSeconds(),
        when.getUTCMilliseconds()]
        .forEach((value, at)=>view.setUint16(offset + at * 2, value, true));
}

/**
 * The names Windows gives a zone's two periods: its key, and the key's
 * "Daylight" form where the key is a "Standard Time".
 *
 * @param {string} key
 */
export const zoneNames = key=>({
    standard: key,
    daylight: key.endsWith(' Standard Time') ? `${key.slice(0, -14)} Daylight Time` : key,
});

/**
 * The TIME_ZONE_INFORMATION of a zone, by its key, for a year: null for a
 * key Windows does not have, or a zone the platform has no data for.
 *
 * @param {string} key @param {number} year
 * @returns {Uint8Array | null}
 */
export function zoneForYear(key, year){
    const zone = IANA.get(key);
    if (zone === undefined)
    {
        return null;
    }
    let rules;
    try
    {
        rules = changesIn(zone, year);
    }
    catch (e){
        void e;
        return null;
    }
    const bytes = new Uint8Array(TZI.SIZE);
    const view = new DataView(bytes.buffer);
    const names = zoneNames(key);
    putName(view, TZI.StandardName, names.standard);
    putName(view, TZI.DaylightName, names.daylight);
    const { first, changes } = rules;
    /** A change's moment on the clock before it; midnight is the day before's last instant. */
    const localBefore = (/** @type {{ at: number, before: number }} */ change)=>{
        const local = change.at + change.before * MINUTE;
        return local % DAY === 0 ? local - 1 : local;
    };
    if (changes.length === 0)
    {
        view.setInt32(TZI.Bias, -first, true);
        view.setInt32(TZI.DaylightBias, -60, true);
        return bytes;
    }
    const last = changes[changes.length - 1].after;
    if (changes.length === 1 || last !== first)
    {
        // The zone moved for good: the year ends in its standard offset, and
        // it was "daylight" until the move.
        view.setInt32(TZI.Bias, -last, true);
        view.setInt32(TZI.DaylightBias, last - first, true);
        putDate(view, TZI.DaylightDate, Date.UTC(year, 0, 1));
        putDate(view, TZI.StandardDate, localBefore(changes[changes.length - 1]));
        return bytes;
    }
    const offsets = [first, ...changes.map(change=>change.after)];
    const standard = Math.min(...offsets);
    const daylight = Math.max(...offsets);
    const into = changes.find(change=>change.after === daylight);
    const outOf = [...changes].reverse().find(change=>change.after === standard);
    view.setInt32(TZI.Bias, -standard, true);
    view.setInt32(TZI.DaylightBias, standard - daylight, true);
    if (into !== undefined && outOf !== undefined)
    {
        putDate(view, TZI.DaylightDate, localBefore(into));
        putDate(view, TZI.StandardDate, localBefore(outOf));
    }
    return bytes;
}
