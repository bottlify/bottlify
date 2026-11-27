/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createTimeFunctions, strftime, asctime, parseTz, TM, C_TIME_NAMES, LC_TIME_DATA,
} from './time.js';
import { fakeMemory, fakeFpu } from './harness.test.js';
import { guestWindow } from './guest-window.fixture.js';
import { declaredTable, longCall } from '../common/long-call.fixture.js';

/** 2003-07-03T12:34:56Z, a Thursday. */
const WALL = Date.UTC(2003, 6, 3, 12, 34, 56);

const build = (/** @type {any} */ fpu = undefined)=>{
    const memory = fakeMemory();
    let running = 1500;
    const table = /** @type {Record<string, any>} */ (createTimeFunctions({
        ...memory,
        systemTimeMs: ()=>WALL,
        now: ()=>running,
        fpu,
    }));
    return { memory, table, advance: (/** @type {number} */ ms)=>{
        running += ms;
    } };
};

test('time answers seconds and writes them through the pointer as well', ()=>{
    const { memory, table } = build();
    const out = memory.allocate(4);
    const seconds = table.time.handler([out]);
    assert.equal(seconds, Math.floor(WALL / 1000));
    assert.equal(memory.u32(out), Math.floor(WALL / 1000));
    assert.doesNotThrow(()=>table.time.handler([0]), 'a null pointer is allowed');
});

test('clock is the running time, so a difference of two calls is an interval', ()=>{
    const { table, advance } = build();
    const start = table.clock.handler([]);
    advance(250);
    assert.equal(table.clock.handler([]) - start, 250);
});

test('localtime fills a struct tm whose fields are where the compiler put them', ()=>{
    const { memory, table } = build();
    const seconds = memory.allocate(4);
    memory.setU32(seconds, Math.floor(WALL / 1000));
    const block = table.localtime.handler([seconds]);

    assert.equal(memory.i32(block + TM.SEC), 56);
    assert.equal(memory.i32(block + TM.MIN), 34);
    assert.equal(memory.i32(block + TM.HOUR), 12);
    assert.equal(memory.i32(block + TM.MDAY), 3);
    assert.equal(memory.i32(block + TM.MON), 6, 'July is month six, not seven');
    assert.equal(memory.i32(block + TM.YEAR), 103, 'years since 1900');
    assert.equal(memory.i32(block + TM.WDAY), 4);
    assert.equal(memory.i32(block + TM.YDAY), 183);
});

test('mktime normalises the fields it was given and writes them back', ()=>{
    const { memory, table } = build();
    const block = memory.allocate(TM.SIZE);
    memory.writeMemory(block, new Uint8Array(TM.SIZE));
    // The 32nd of January, which a caller produces by adding to tm_mday.
    new DataView(memory.bytes.buffer).setInt32(block + TM.MDAY, 32, true);
    new DataView(memory.bytes.buffer).setInt32(block + TM.YEAR, 103, true);

    const seconds = table.mktime.handler([block]);
    assert.equal(seconds, Date.UTC(2003, 1, 1) / 1000);
    assert.equal(memory.i32(block + TM.MON), 1, 'rolled into February');
    assert.equal(memory.i32(block + TM.MDAY), 1);
});

test('asctime is the fixed 25-character form from the fields themselves, or none', ()=>{
    // Wine's msvcrt test_asctime: the day of the month in two digits, the
    // day of the week as tm_wday names it, a year past 9999 wrapping its
    // first digit, and null for a field out of range or a day the month has not.
    const tm = { sec: 56, min: 34, hour: 12, mday: 3, mon: 6, year: 103, wday: 4, yday: 0,
        isdst: 0 };
    const text = asctime(tm);
    assert.equal(text, 'Thu Jul 03 12:34:56 2003\n');
    assert.equal(text?.length, 25, 'callers index into this');
    assert.equal(asctime({ ...tm, wday: 3 }), 'Wed Jul 03 12:34:56 2003\n');
    assert.equal(asctime({ ...tm, year: 8100 }), 'Thu Jul 03 12:34:56 :000\n');
    assert.equal(asctime({ ...tm, year: 264100 }), 'Thu Jul 03 12:34:56 :000\n');
    assert.equal(asctime({ ...tm, wday: 7 }), null);
    assert.equal(asctime({ ...tm, year: -1 }), null);
    assert.equal(asctime({ ...tm, mon: 1, mday: 30 }), null);
});

test('ctime and asctime share one buffer, as documented', ()=>{
    const { memory, table } = build();
    const seconds = memory.allocate(4);
    memory.setU32(seconds, Math.floor(WALL / 1000));
    const first = table.ctime.handler([seconds]);
    assert.equal(memory.text(first), 'Thu Jul 03 12:34:56 2003\n');
    assert.equal(table.asctime.handler([table.localtime.handler([seconds])]), first);
});

test('_wctime writes the same text wide, into a buffer of its own', ()=>{
    const { memory, table } = build();
    const seconds = memory.allocate(4);
    memory.setU32(seconds, Math.floor(WALL / 1000));
    const narrow = table.ctime.handler([seconds]);
    const wide = table._wctime.handler([seconds]);
    assert.notEqual(wide, narrow);
    const units = new Uint16Array(memory.bytes.slice(wide, wide + 52).buffer);
    assert.equal(String.fromCharCode(...units), 'Thu Jul 03 12:34:56 2003\n\0');
    assert.equal(memory.text(narrow), 'Thu Jul 03 12:34:56 2003\n', 'the narrow text kept');
    assert.equal(table._wctime.handler([0]), 0);
    assert.equal(table._wctime64.argBytes, 4);
});

/** WALL's fields. */
const WALL_TM = { sec: 56, min: 34, hour: 12, mday: 3, mon: 6, year: 103, wday: 4, yday: 183,
    isdst: 0 };

/** A struct tm's fields in their order, sec..isdst. @param {number[]} fields */
const tmOf = fields=>{
    const [sec, min, hour, mday, mon, year, wday, yday, isdst] = fields;
    return { sec, min, hour, mday, mon, year, wday, yday, isdst };
};

test('strftime renders the fields a program actually asks for', ()=>{
    assert.equal(strftime('%Y-%m-%d %H:%M:%S', WALL_TM), '2003-07-03 12:34:56');
    assert.equal(strftime('%a %b %j %p %I', WALL_TM), 'Thu Jul 184 PM 12');
    assert.equal(strftime('100%%', WALL_TM), '100%');
});

test('strftime refuses a conversion msvcrt does not know', ()=>{
    for (const format of ['%C', '%D', '%e', '%F', '%h', '%n', '%R', '%t', '%T', '%u', 'a%e',
        '%q!', 'end %'])
    {
        assert.equal(strftime(format, WALL_TM), null, format);
    }
    assert.equal(strftime('e%#%e', WALL_TM), 'e%e', '%#% is a percent sign');
});

test('strftime reads the fields as they are, unnormalised', ()=>{
    const epoch = tmOf([0, 0, 0, 1, 0, 70, 4, 0, 0]);
    const thirtieth = tmOf([0, 0, 0, 30, 1, 70, 4, 0, 0]);
    assert.equal(strftime('%c', epoch), '01/01/70 00:00:00');
    assert.equal(strftime('%c', thirtieth), '02/30/70 00:00:00');
    assert.equal(strftime('%#c', thirtieth), 'Thursday, February 30, 1970 00:00:00');
    assert.equal(strftime('%#x', thirtieth), 'Thursday, February 30, 1970');
    assert.equal(strftime('%X', tmOf([0, 0, 14, 1, 0, 70, 4, 0, 0])), '14:00:00');
    assert.equal(strftime('%I %j %#M %p %#d', epoch), '12 001 0 AM 1');
    assert.equal(strftime('%U %W', epoch), '00 00');
    assert.equal(strftime('%U %W', tmOf([0, 0, 0, 1, 0, 70, 0, 0, 0])), '01 00');
    assert.equal(strftime('%U %W', tmOf([0, 0, 0, 1, 0, 70, 0, 365, 0])), '53 52');
    assert.equal(strftime('%a', tmOf([0, 0, 0, 1, 0, 70, 7, 0, 0])), null, 'no eighth day');
    assert.equal(strftime('%H', tmOf([0, 0, 24, 1, 0, 70, 4, 0, 0])), null);
});

test('strftime reads no struct for a format of plain text', ()=>{
    assert.equal(strftime('copy', null), 'copy');
    assert.equal(strftime('%c', null), null);
});

test('strftime leaves an empty string when the result would not fit', ()=>{
    const { memory, table } = build();
    const buffer = memory.allocate(32);
    memory.writeMemory(buffer, new Uint8Array(32).fill(0x2e));
    const block = table.localtime.handler([memory.allocate(4)]);
    assert.equal(table.strftime.handler([buffer, 4, memory.put('%Y-%m-%d'), block]), 0);
    assert.equal(memory.text(buffer), '', 'no truncated text');
});

test('strftime answers a null struct, a null buffer and a refused format as Windows does', ()=>{
    const { memory, table } = build();
    const buffer = memory.allocate(32);
    const block = table.localtime.handler([memory.allocate(4)]);
    assert.equal(table.strftime.handler([buffer, 32, memory.put('copy'), 0]), 4);
    assert.equal(memory.text(buffer), 'copy');
    assert.equal(table.strftime.handler([0, 0, memory.put('copy'), block]), 0);
    assert.equal(table.strftime.handler([buffer, 32, memory.put('a%e'), block]), 0);
    assert.equal(memory.text(buffer), '');
});

test('_Strftime expands a locale\'s pictures letter by letter', ()=>{
    const names = { ...C_TIME_NAMES, shortDays: ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'],
        days: [1, 2, 3, 4, 5, 6, 7].map(n=>`day${n}`),
        shortMonths: Array.from({ length: 12 }, (_, n)=>`m${n + 1}`),
        months: Array.from({ length: 12 }, (_, n)=>`mon${n + 1}`), am: 'tam', pm: 'tpm' };
    const at = (/** @type {number} */ hour)=>tmOf([0, 0, hour, 1, 0, 70, 0, 0, 0]);
    /** @type {[string, string, number][]} */
    const time = [['MMM', 'm1', 1], ['h', '1', 1], ['hh', '01', 1], ['hhh', 'h01', 1],
        ['hhhh', 'hh01', 1], ['H', '1', 1], ['HHH', 'H13', 13], ['m', '0', 0], ['sss', 's00', 0],
        ['t', 't', 0], ['tt', 'tam', 0], ['ttttttttt', 'tam', 0], ['a', 'tam', 0],
        ['AAAAA', 'tam', 0]];
    for (const [picture, expected, hour] of time)
    {
        assert.equal(strftime('%X', at(hour), { ...names, time: picture }), expected, picture);
    }
    /** @type {[string, string][]} */
    const date = [['d', '1'], ['dd', '01'], ['ddd', 'd1'], ['dddd', 'day1'], ['ddddd', 'dday1'],
        ['M', '1'], ['MMMM', 'mon1'], ['MMMMM', 'Mmon1'], ['y', 'y'], ['yy', '70'],
        ['yyy', 'y70'], ['yyyy', '1970'], ['yyyyy', 'y1970'], ['ggggggggggg', 'ggggggggggg']];
    for (const [picture, expected] of date)
    {
        assert.equal(strftime('%x', at(0), { ...names, shortDate: picture }), expected, picture);
        assert.equal(strftime('%#x', at(0), { ...names, longDate: picture }), expected, picture);
    }
});

test('strftime keeps the upper-half bytes of its format as they were', ()=>{
    // The memory layer reads the format as Windows-1252, where 0x80 is the
    // euro sign, 0x99 the trade mark and 0x97 an em dash; the result is
    // written in the same page, so the text around the fields is the caller's.
    const { memory, table } = build();
    const buffer = memory.allocate(32);
    const block = table.localtime.handler([memory.allocate(4)]);
    const format = memory.allocate(8);
    memory.writeMemory(format, Uint8Array.of(0x80, 0x25, 0x59, 0x99, 0x97, 0));
    assert.equal(table.strftime.handler([buffer, 32, format, block]), 7);
    assert.deepEqual([...memory.bytes.subarray(buffer, buffer + 8)],
        [0x80, 0x31, 0x39, 0x37, 0x30, 0x99, 0x97, 0]);
});

test('_strdate and _strtime are the two fixed nine-byte forms', ()=>{
    const { memory, table } = build();
    const date = memory.allocate(16);
    const time = memory.allocate(16);
    table._strdate.handler([date]);
    table._strtime.handler([time]);
    assert.equal(memory.text(date), '07/03/03');
    assert.equal(memory.text(time), '12:34:56');
});

test('_ftime lays out seconds then milliseconds, as the struct does', ()=>{
    const { memory, table } = build();
    const block = memory.allocate(12);
    table._ftime.handler([block]);
    assert.equal(memory.u32(block), Math.floor(WALL / 1000));
    assert.equal(new DataView(memory.bytes.buffer).getUint16(block + 4, true), WALL % 1000);
});

test('difftime needs the FPU seam, and is signed when it has one', ()=>{
    assert.equal(build().table.difftime, undefined);
    const fpu = fakeFpu();
    build(fpu).table.difftime.handler([10, 25]);
    assert.equal(fpu.result, -15);
});

/**
 * The time functions with an environment and cells of their own, the
 * variables placed where the zone's accessors can be read through.
 *
 * @param {Record<string, string>} variables
 */
const zoned = (variables = {})=>{
    const memory = fakeMemory();
    /** @type {Map<string, number>} */
    const cells = new Map();
    const table = /** @type {Record<string, any>} */ (createTimeFunctions({
        ...memory,
        systemTimeMs: ()=>WALL,
        now: ()=>0,
        getenv: name=>variables[name] ?? null,
        cell: name=>{
            if (!cells.has(name))
            {
                cells.set(name, memory.allocate(4));
            }
            return /** @type {number} */ (cells.get(name));
        },
        errno: ()=>{},
    }));
    /** @param {string} name */
    const read = name=>memory.i32(table[name].handler([]));
    return { memory, table, variables, read };
};

test('the zone holds msvcrt\'s compiled Pacific time until TZ is read, and TZ\'s after', ()=>{
    const { table, variables, read } = zoned();
    assert.deepEqual([read('__p__daylight'), read('__p__timezone'), read('__p__dstbias')],
        [1, 28800, -3600]);
    variables.TZ = 'xxx+1yyy';
    table._tzset.handler([]);
    assert.deepEqual([read('__p__daylight'), read('__p__timezone')], [0x79, 3600],
        '_daylight is the first character of the daylight name');
    variables.TZ = 'xxx+1:3:5zzz';
    table._tzset.handler([]);
    assert.deepEqual([read('__p__daylight'), read('__p__timezone')], [0x7a, 3785]);
    assert.deepEqual(parseTz('EST5EDT'), { timezone: 18000, daylight: 0x45,
        names: ['EST', 'EDT'] });
    assert.deepEqual(parseTz('CET-1'), { timezone: -3600, daylight: 0, names: ['CET', ''] });
    assert.equal(table.__daylight.handler([]), table.__p__daylight.handler([]));
});

test('a conversion reads the zone once, and with no TZ the machine\'s is UTC', ()=>{
    const { memory, table, variables, read } = zoned({ TZ: 'EST5' });
    table._tzset.handler([]);
    const seconds = memory.allocate(4);
    memory.setU32(seconds, Math.floor(WALL / 1000));
    delete variables.TZ;
    // The first conversion reads TZ again, whatever _tzset read before.
    const block = table.localtime.handler([seconds]);
    assert.equal(memory.i32(block + TM.HOUR), 12);
    assert.equal(read('__p__timezone'), 0);
    variables.TZ = 'EST5';
    table.localtime.handler([seconds]);
    assert.equal(memory.i32(block + TM.HOUR), 12, 'and not again');
    table._tzset.handler([]);
    table.localtime.handler([seconds]);
    assert.equal(memory.i32(block + TM.HOUR), 7, 'until _tzset reads it');
});

test('gmtime refuses -1 and a time more than half a day before 1970, as msvcrt does', ()=>{
    const { memory, table } = zoned();
    const at = memory.allocate(8);
    /** @param {number} value */
    const gmtime = value=>{
        memory.setU32(at, value >>> 0);
        return table._gmtime32.handler([at]);
    };
    assert.equal(gmtime(-1), 0);
    assert.equal(gmtime(-43201), 0);
    const block = gmtime(-43200);
    assert.deepEqual([memory.i32(block + TM.YEAR), memory.i32(block + TM.HOUR)], [70, -12],
        'within the half day, 1970 at a negative hour');
    const tm = memory.allocate(TM.SIZE);
    memory.setU32(at, 0xffffffff);
    assert.equal(table._gmtime32_s.handler([tm, at]), 22);
    assert.equal(memory.i32(tm + TM.YEAR), -1, 'a refused time leaves every field -1');
    assert.equal(table._localtime32_s.handler([0, at]), 22);
});

test('_mkgmtime normalises in UTC whatever tm_isdst says, and mktime refuses before 1970', ()=>{
    const { memory, table } = zoned();
    const block = memory.allocate(TM.SIZE);
    const view = new DataView(memory.bytes.buffer);
    memory.writeMemory(block, new Uint8Array(TM.SIZE));
    view.setInt32(block + TM.MDAY, 3, true);
    view.setInt32(block + TM.YEAR, 70, true);
    view.setInt32(block + TM.HOUR, 48, true);
    view.setInt32(block + TM.ISDST, 1, true);
    assert.equal(table._mkgmtime32.handler([block]), 4 * 86400);
    assert.deepEqual([memory.i32(block + TM.MDAY), memory.i32(block + TM.WDAY),
        memory.i32(block + TM.YDAY)], [5, 1, 4]);
    view.setInt32(block + TM.YEAR, 69, true);
    assert.equal(table.mktime.handler([block]), -1);
});

/** A struct tm in guest memory. @param {any} memory @param {number[]} fields sec..isdst */
const putTm = (memory, fields)=>{
    const block = memory.allocate(TM.SIZE);
    fields.forEach((value, at)=>memory.setU32(block + at * 4, value));
    return block;
};

test('strftime\'s # flag gives the long date and drops a number\'s leading zeros', ()=>{
    const when = tmOf([9, 8, 7, 4, 2, 105, 5, 62, 0]);
    assert.equal(strftime('%x|%X|%c', when), '03/04/05|07:08:09|03/04/05 07:08:09');
    assert.equal(strftime('%#x', when), 'Friday, March 04, 2005');
    assert.equal(strftime('%#c', when), 'Friday, March 04, 2005 07:08:09');
    assert.equal(strftime('%#d/%#m/%#y %#H:%#M %#j', when), '4/3/5 7:8 63');
});

test('strftime takes a locale\'s names and pictures in place of the C locale\'s', ()=>{
    const when = tmOf([9, 8, 15, 4, 2, 105, 5, 62, 0]);
    const names = { ...C_TIME_NAMES, shortDays: C_TIME_NAMES.shortDays.map(d=>d.toUpperCase()),
        am: 'vm', pm: 'nm', shortDate: "d.M.yyyy 'r.'", time: 'h:mm tt' };
    assert.equal(strftime('%a %p %x %X', when, names), 'FRI nm 4.3.2005 r. 3:08 nm');
});

test('wcsftime writes strftime\'s text in UTF-16, counted in characters', ()=>{
    const { memory, table } = build();
    const block = putTm(memory, [9, 8, 7, 4, 2, 105, 5, 62, 0]);
    const buffer = memory.allocate(64);
    assert.equal(table.wcsftime.argBytes, 16);
    assert.equal(table.wcsftime.handler([buffer, 32, memory.putWide('%A \u3042 %H:%M'), block]),
        'Friday \u3042 07:08'.length);
    assert.equal(memory.wide(buffer), 'Friday \u3042 07:08');
    assert.equal(table.wcsftime.handler([buffer, 5, memory.putWide('%A'), block]), 0,
        'six characters do not fit in five');
});

test('_Getdays and _Getmonths hand out the names the runtime\'s way, on the heap', ()=>{
    const { memory, table } = build();
    const days = memory.text(table._Getdays.handler([]));
    assert.ok(days.startsWith(':Sun:Sunday:Mon:Monday:'));
    assert.ok(days.endsWith(':Sat:Saturday'));
    const months = memory.text(table._Getmonths.handler([]));
    assert.ok(months.startsWith(':Jan:January:Feb:February:'));
    assert.ok(months.endsWith(':Dec:December'));
});

test('_Gettnames copies __lc_time_data whole, and _Strftime formats with what it holds', ()=>{
    const { memory, table } = build();
    const names = table._Gettnames.handler([]);
    assert.notEqual(names, 0);
    const string = (/** @type {number} */ index)=>memory.text(memory.u32(names + index * 4));
    assert.equal(string(0), 'Sun');
    assert.equal(string(7), 'Sunday');
    assert.equal(string(14), 'Jan');
    assert.equal(string(26), 'January');
    assert.deepEqual([38, 39, 40, 41, 42].map(string),
        ['AM', 'PM', 'MM/dd/yy', 'dddd, MMMM dd, yyyy', 'HH:mm:ss']);
    assert.ok(memory.u32(names) > names + LC_TIME_DATA.SIZE - 1, 'the strings follow it');

    const block = putTm(memory, [9, 8, 15, 4, 2, 105, 5, 62, 0]);
    const buffer = memory.allocate(64);
    assert.equal(table._Strftime.argBytes, 20);
    // A locale's names, written where the copy's first pointer points.
    memory.setU32(names, memory.put('Vr'));
    memory.setU32(names + 38 * 4, memory.put('vm'));
    memory.setU32(names + 39 * 4, memory.put('nm'));
    assert.equal(table._Strftime.handler([buffer, 64, memory.put('%a %p %c'), block, names]),
        'Fri nm 03/04/05 15:08:09'.length);
    assert.equal(memory.text(buffer), 'Fri nm 03/04/05 15:08:09');
    table._Strftime.handler([buffer, 64, memory.put('%a'), putTm(memory,
        [0, 0, 0, 6, 2, 105, 0, 64, 0]), names]);
    assert.equal(memory.text(buffer), 'Vr', 'Sunday is the first of them');
    assert.equal(table._Strftime.handler([buffer, 64, memory.put('%p'), block, 0]), 2);
    assert.equal(memory.text(buffer), 'PM', 'no names: the current locale\'s');
});

test('the universal runtime\'s strftime knows C99\'s conversions msvcrt refuses', ()=>{
    const epoch = tmOf([0, 0, 0, 1, 0, 70, 4, 0, 0]);
    /** @param {string} format @param {any} [tm] */
    const standard = (format, tm = epoch)=>strftime(format, tm, C_TIME_NAMES, true);
    assert.equal(standard('%C %D %e %F'), '19 01/01/70  1 1970-01-01');
    assert.equal(standard('%#D %#e %#F %#R %#T'), '1/1/70 1 1970-1-1 0:0 0:0:0');
    assert.equal(standard('%h|%n|%t|%u|%R|%T'), 'Jan|\n|\t|4|00:00|00:00:00');
    assert.equal(standard('%r', tmOf([0, 0, 14, 1, 0, 70, 4, 0, 0])), '02:00:00 PM');
    assert.equal(standard('%Oy %Ey'), '70 70', 'E and O change nothing in the C locale');
    assert.equal(standard('%z')?.length, 5);
    assert.equal(strftime('%e', epoch), null, 'msvcrt\'s still refuses');
});

test('%V and %G are ISO 8601\'s week and its year, across the turn of a year', ()=>{
    /** @param {number} year @param {number} wday @param {number} yday */
    const day = (year, wday, yday)=>tmOf([0, 0, 0, 1, 0, year - 1900, wday, yday, 0]);
    /** @param {any} tm */
    const iso = tm=>strftime('%G %V %g', tm, C_TIME_NAMES, true);
    // 1 January 1999, a Friday: still the 53rd week of 1998.
    assert.equal(iso(day(1999, 5, 0)), '1998 53 98');
    // 4 January 1999, a Monday: week one.
    assert.equal(iso(day(1999, 1, 3)), '1999 01 99');
    // 31 December 2002, a Tuesday: week one of 2003.
    assert.equal(iso(day(2002, 2, 364)), '2003 01 03');
    // 1 January 1970, a Thursday: week one of its own year.
    assert.equal(iso(day(1970, 4, 0)), '1970 01 70');
});

test('at 64 bits past 4 GiB: time_t is an __int64, the names\' pointers are quadwords, and a'
    + ' block whose low dword is zero is a block', ()=>{
    // A wide window's block at 0x100000000: its low dword alone is null.
    const base = 2 ** 32;
    const bytes = new Uint8Array(0x2000);
    const view = new DataView(bytes.buffer);
    const guest = guestWindow(bytes, { base, pointerSize: 8 });
    let next = base + 0x1000;
    /** @type {number[]} */
    const high = [];
    const table = /** @type {Record<string, any>} */ (createTimeFunctions({
        guest,
        allocate: size=>{
            const at = next;
            next += size + 15 & ~15;
            return at;
        },
        systemTimeMs: ()=>WALL,
        now: ()=>0,
        setRegisters: ({ edx })=>void high.push(edx),
    }));
    /** @param {number} at */
    const quad = at=>Number(view.getBigInt64(at - base, true));

    // time and localtime are _time64 and _localtime64 here.
    assert.equal(table.time.handler([base]), Math.floor(WALL / 1000));
    assert.equal(quad(base), Math.floor(WALL / 1000), 'eight bytes, at the block\'s start');
    view.setBigInt64(0x10, BigInt(Date.UTC(2200, 0, 1) / 1000), true);
    const tm = table.localtime.handler([base + 0x10]);
    assert.equal(guest.i32(tm + TM.YEAR), 300, 'a time past 2038, read whole');
    view.setBigInt64(0x10, BigInt(WALL / 1000), true);
    assert.match(guest.cstr(table.ctime.handler([base + 0x10]), 64), /2003/);

    // strftime's buffer at the block's start; its format and tm past it.
    guest.writeAnsi(base + 0x100, '%Y-%m-%d');
    guest.set32s(base + 0x200, [56, 34, 12, 3, 6, 103, 4, 183, 0]);
    assert.equal(table.strftime.handler([base, 32, base + 0x100, base + 0x200]), 10);
    assert.equal(guest.cstr(base, 32), '2003-07-03');

    // _tzname: two pointers of eight bytes each, to the two names - the
    // machine's zone's, which the first conversion read.
    const tzname = table._tzname.data();
    assert.equal(tzname.length, 16);
    const zone = new DataView(tzname.buffer, tzname.byteOffset);
    assert.equal(guest.cstr(Number(zone.getBigUint64(0, true)), 64), 'UTC');
    assert.equal(guest.cstr(Number(zone.getBigUint64(8, true)), 64), 'UTC');
    assert.notEqual(zone.getBigUint64(0, true), zone.getBigUint64(8, true), 'two buffers');

    // __lc_time_data at 64 bits: its 43 pointers quadwords, then its ints.
    const names = table._Gettnames.handler([]);
    assert.equal(guest.cstr(guest.ptr(names), 8), 'Sun');
    assert.equal(guest.cstr(guest.ptr(names + 42 * 8), 16), 'HH:mm:ss');
    assert.equal(guest.u32(names + 43 * 8 + 4), 1, 'the Gregorian calendar after them');
    guest.writeAnsi(base + 0x140, '%a %B');
    assert.equal(table._Strftime.handler([base + 0x300, 32, base + 0x140, base + 0x200,
        names]), 'Thu July'.length);
    assert.equal(guest.cstr(base + 0x300, 32), 'Thu July');
});

test('at 64 bits past 4 GiB: every spelling of a conversion takes and answers its pointers'
    + ' whole as the bridge hands them', async()=>{
    const base = 0x140000000;
    const bytes = new Uint8Array(0x2000);
    const guest = guestWindow(bytes, { base, pointerSize: 8 });
    let next = base + 0x1000;
    const table = declaredTable(/** @type {Record<string, any>} */ (createTimeFunctions({
        guest,
        allocate: size=>{
            const at = next;
            next += size + 15 & ~15;
            return at;
        },
        systemTimeMs: ()=>WALL,
        now: ()=>0,
        setRegisters: ()=>{},
    })));
    const time = base + 0x10;
    guest.set64(time, BigInt(WALL / 1000));
    /** @param {bigint} rax */
    const inWindow = rax=>rax >= BigInt(base) && rax < BigInt(base + bytes.length);
    for (const name of ['_localtime64', '_gmtime64', '_ctime64', '_wctime64'])
    {
        assert.ok(inWindow(await longCall(table[name], [time])), name);
    }
    guest.set32(time, WALL / 1000);
    for (const name of ['_localtime32', '_gmtime32', '_ctime32', '_wctime32'])
    {
        assert.ok(inWindow(await longCall(table[name], [time])), name);
    }
    await longCall(table._localtime32_s, [base + 0x100, time]);
    assert.equal(guest.i32(base + 0x100 + TM.YEAR), 103, 'into the caller\'s tm');
    assert.equal(await longCall(table._ctime32_s, [base + 0x200, 64, time]), 0n);
    assert.match(guest.cstr(base + 0x200, 64), /2003/);
    assert.equal(await longCall(table._strtime_s, [base + 0x300, 16]), 0n);
    assert.equal(await longCall(table._time32, [base + 0x400]), BigInt(WALL / 1000));
    assert.equal(guest.u32(base + 0x400), WALL / 1000);
    assert.equal(await longCall(table._mktime32, [base + 0x100]), BigInt(WALL / 1000));
    assert.equal(await longCall(table._get_daylight, [base + 0x500]), 0n);
    await longCall(table._ftime, [base + 0x600]);
    assert.equal(Number(guest.i64(base + 0x600)), Math.floor(WALL / 1000));
    assert.ok(inWindow(await longCall(table._Getmonths, [])), 'a block of its own, whole');
});
