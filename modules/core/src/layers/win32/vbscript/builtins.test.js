/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VBScriptError, createVBScriptEngine } from './engine.js';

/** 8 October 2026, 10:34:56.789 UTC; the machine is two hours ahead. */
const NOW = Date.UTC(2026, 9, 8, 10, 34, 56, 789);

/** @param {import('./engine.js').VBScriptOptions} [options] */
const engine = (options = {})=>createVBScriptEngine({ now: ()=>NOW,
    localOffset: ()=>2 * 3600000, ...options });

/**
 * Each expression's value, as CStr spells it after its TypeName: what a
 * script itself can observe of it.
 *
 * @param {[string, string][]} cases
 */
async function expect(cases){
    for (const [text, expected] of cases)
    {
        const e = engine();
        await e.run(`Dim v: v = ${text}\nIf IsNull(v) Then out = "Null" Else out = TypeName(v) `
            + '& ":" & CStr(v)');
        assert.equal(e.getGlobal('out'), expected, text);
    }
}

/**
 * The error number each expression fails with.
 *
 * @param {[string, number][]} cases
 */
async function errors(cases){
    for (const [text, number] of cases)
    {
        await assert.rejects(engine().run(`x = ${text}`),
            e=>e instanceof VBScriptError && e.number === number, text);
    }
}

test('the conversion functions, by subtype and spelling', async()=>{
    await expect([
        ['CBool(1)', 'Boolean:True'], ['CBool("False")', 'Boolean:False'],
        ['CBool("0")', 'Boolean:False'], ['CBool(Empty)', 'Boolean:False'],
        ['CByte(255.4)', 'Byte:255'], ['CInt(2.5)', 'Integer:2'], ['CInt(3.5)', 'Integer:4'],
        ['CInt(-2.5)', 'Integer:-2'], ['CInt("12")', 'Integer:12'], ['CInt(True)', 'Integer:-1'],
        ['CLng("&HFF")', 'Long:255'], ['CLng(2147483647)', 'Long:2147483647'],
        ['CSng(1 / 3)', 'Single:0.3333333'], ['CDbl("1,000.5")', 'Double:1000.5'],
        ['CDbl(" 7 ")', 'Double:7'], ['CCur(1.23456)', 'Currency:1.2346'],
        ['CCur(10)', 'Currency:10'], ['CStr(1 / 3)', 'String:0.333333333333333'],
        ['CStr(0.1 + 0.2)', 'String:0.3'], ['CStr(1E+21)', 'String:1E+21'],
        ['CStr(1.5E-7)', 'String:1.5E-07'], ['CStr(0.0001)', 'String:0.0001'],
        ['CStr(123456789012345678)', 'String:1.23456789012346E+17'],
        ['CStr(-0.5)', 'String:-0.5'], ['CStr(True)', 'String:True'], ['CStr(Empty)', 'String:'],
        ['CDate("1/2/2003")', 'Date:1/2/2003'],
        ['CDate("1/2/2003 13:05")', 'Date:1/2/2003 1:05:00 PM'],
        ['CDate("13:05")', 'Date:1:05:00 PM'], ['CDate(37623.5)', 'Date:1/2/2003 12:00:00 PM'],
        ['CDate("January 2, 2003")', 'Date:1/2/2003'],
        ['Hex(-1)', 'String:FFFF'], ['Hex(CLng(-1))', 'String:FFFFFFFF'], ['Hex(255)', 'String:FF'],
        ['Hex(65536)', 'String:10000'], ['Oct(8)', 'String:10'], ['Hex(Null)', 'Null'],
        ['Fix(-1.5)', 'Double:-1'], ['Int(-1.5)', 'Double:-2'], ['Int(CInt(5))', 'Integer:5'],
        ['Fix("2.7")', 'Double:2'], ['Abs(-32768)', 'Long:32768'], ['Abs(CInt(-5))', 'Integer:5'],
        ['Round(2.5)', 'Double:2'], ['Round(3.5)', 'Double:4'], ['Round(1.2345, 2)', 'Double:1.23'],
        ['Round(1.235, 2)', 'Double:1.24'], ['Sgn(-3)', 'Integer:-1'], ['Sqr(16)', 'Double:4'],
        ['Abs(Null)', 'Null'], ['Int(Empty)', 'Integer:0'],
    ]);
    await errors([
        ['CByte(256)', 6], ['CInt(32767.5)', 6], ['CLng(2147483648)', 6], ['CBool("yes")', 13],
        ['CDbl("abc")', 13], ['CDbl("")', 13], ['CStr(Null)', 94], ['CInt(Null)', 94],
        ['CDate("not a date")', 13], ['Sqr(-1)', 5], ['Log(0)', 5], ['1 / 0', 11], ['0 / 0', 6],
        ['5 \\ 0', 11], ['"a" * 2', 13], ['Array(1) + 1', 13], ['Exp(1000)', 6],
        ['Round(1, -1)', 5],
    ]);
});

test('the type functions', async()=>{
    await expect([
        ['VarType(Empty)', 'Integer:0'], ['VarType(Null)', 'Integer:1'],
        ['VarType(1)', 'Integer:2'],
        ['VarType(1.5)', 'Integer:5'], ['VarType("")', 'Integer:8'],
        ['VarType(True)', 'Integer:11'],
        ['VarType(Array())', 'Integer:8204'], ['VarType(Nothing)', 'Integer:9'],
        ['VarType(Now)', 'Integer:7'], ['VarType(CCur(1))', 'Integer:6'],
        ['IsNumeric("12.5")', 'Boolean:True'], ['IsNumeric("&H1F")', 'Boolean:True'],
        ['IsNumeric("abc")', 'Boolean:False'], ['IsNumeric(Empty)', 'Boolean:True'],
        ['IsNumeric(Null)', 'Boolean:False'], ['IsNumeric(Now)', 'Boolean:False'],
        ['IsEmpty(Empty)', 'Boolean:True'], ['IsEmpty("")', 'Boolean:False'],
        ['IsArray(Array())', 'Boolean:True'], ['IsDate("1/2/2003")', 'Boolean:True'],
        ['IsDate("tomorrow")', 'Boolean:False'], ['IsDate(1)', 'Boolean:False'],
        ['TypeName(Empty)', 'String:Empty'], ['TypeName(Null)', 'String:Null'],
        ['TypeName(CByte(1))', 'String:Byte'], ['TypeName(Err)', 'String:ErrObject'],
        ['TypeName(New RegExp)', 'String:IRegExp2'],
    ]);
});

test('the string functions', async()=>{
    await expect([
        ['Len("hello")', 'Long:5'], ['Len(123)', 'Long:3'], ['Len(Null)', 'Null'],
        ['Left("hello", 2)', 'String:he'], ['Right("hello", 3)', 'String:llo'],
        ['Left("hi", 9)', 'String:hi'], ['Mid("hello", 2, 3)', 'String:ell'],
        ['Mid("hello", 4)', 'String:lo'], ['Mid("hello", 9)', 'String:'],
        ['InStr("hello", "l")', 'Long:3'], ['InStr(4, "hello", "l")', 'Long:4'],
        ['InStr("hello", "z")', 'Long:0'], ['InStr("Hello", "h")', 'Long:0'],
        ['InStr(1, "Hello", "h", 1)', 'Long:1'], ['InStr("abc", "")', 'Long:1'],
        ['InStr(5, "abc", "")', 'Long:0'], ['InStr(Null, "a")', 'Null'],
        ['InStrRev("abcabc", "bc")', 'Long:5'], ['InStrRev("abcabc", "bc", 4)', 'Long:2'],
        ['LCase("MiXeD")', 'String:mixed'], ['UCase("MiXeD")', 'String:MIXED'],
        ['"[" & Trim("  a b  ") & "]"', 'String:[a b]'],
        ['"[" & LTrim("  a ") & "]"', 'String:[a ]'],
        ['"[" & RTrim(" a  ") & "]"', 'String:[ a]'], ['Space(3) & "|"', 'String:   |'],
        ['String(3, "xy")', 'String:xxx'], ['String(2, 65)', 'String:AA'],
        ['StrComp("a", "b")', 'Integer:-1'], ['StrComp("B", "a")', 'Integer:-1'],
        ['StrComp("B", "a", 1)', 'Integer:1'], ['StrComp("x", "X", vbTextCompare)', 'Integer:0'],
        ['StrReverse("abc")', 'String:cba'], ['Replace("aXbXc", "X", "-")', 'String:a-b-c'],
        ['Replace("aXbXc", "x", "-", 1, -1, 1)', 'String:a-b-c'],
        ['Replace("aXbXc", "X", "-", 3)', 'String:b-c'],
        ['Replace("aaa", "a", "b", 1, 2)', 'String:bba'],
        ['Join(Split("a,b,,c", ","), "|")', 'String:a|b||c'], ['UBound(Split(""))', 'Long:-1'],
        ['Join(Split("a b c", " ", 2), "|")', 'String:a|b c'],
        ['Join(Array(1, "x", True))', 'String:1 x True'],
        ['Join(Filter(Array("apple", "berry", "grape"), "ap"), ",")', 'String:apple,grape'],
        ['Join(Filter(Array("apple", "berry"), "ap", False), ",")', 'String:berry'],
        ['Asc("A")', 'Integer:65'], ['Asc(Chr(128))', 'Integer:128'],
        ['AscW(ChrW(8364))', 'Integer:8364'],
        ['AscW(ChrW(65535))', 'Integer:-1'], ['Chr(65) & ChrW(66)', 'String:AB'],
        ['vbCrLf = Chr(13) & Chr(10)', 'Boolean:True'], ['Len(vbTab)', 'Long:1'],
    ]);
    await errors([
        ['Left("a", -1)', 5], ['Mid("a", 0)', 5], ['Asc("")', 5], ['Chr(256)', 5],
        ['Space(-1)', 5], ['Join("a")', 13], ['StrReverse(Null)', 94],
    ]);
});

test('the date functions, on the machine\'s local clock', async()=>{
    await expect([
        ['Now', 'Date:10/8/2026 12:34:56 PM'], ['Date', 'Date:10/8/2026'],
        ['Time', 'Date:12:34:56 PM'],
        ['Year(Now) & "/" & Month(Now) & "/" & Day(Now)', 'String:2026/10/8'],
        ['Hour(Now) & ":" & Minute(Now) & ":" & Second(Now)', 'String:12:34:56'],
        ['Timer', 'Single:45296.79'], ['Weekday(#10/8/2026#)', 'Integer:5'],
        ['Weekday(#10/8/2026#, vbMonday)', 'Integer:4'], ['WeekdayName(1)', 'String:Sunday'],
        ['WeekdayName(1, True, vbMonday)', 'String:Mon'], ['MonthName(2)', 'String:February'],
        ['MonthName(12, True)', 'String:Dec'], ['DateSerial(2003, 1, 2)', 'Date:1/2/2003'],
        ['DateSerial(2003, 13, 1)', 'Date:1/1/2004'], ['DateSerial(2003, 3, 0)', 'Date:2/28/2003'],
        ['DateSerial(99, 1, 1)', 'Date:1/1/1999'], ['DateSerial(5, 1, 1)', 'Date:1/1/2005'],
        ['TimeSerial(13, 5, 6)', 'Date:1:05:06 PM'], ['TimeSerial(0, 90, 0)', 'Date:1:30:00 AM'],
        ['DateValue("1/2/2003 4:05 PM")', 'Date:1/2/2003'],
        ['TimeValue("4:05 PM")', 'Date:4:05:00 PM'],
        ['DateAdd("m", 1, #1/31/2003#)', 'Date:2/28/2003'],
        ['DateAdd("yyyy", 1, #2/29/2004#)', 'Date:2/28/2005'],
        ['DateAdd("d", -1, #3/1/2003#)', 'Date:2/28/2003'],
        ['DateAdd("h", 25, #1/1/2003#)', 'Date:1/2/2003 1:00:00 AM'],
        ['DateAdd("q", 1, #11/15/2003#)', 'Date:2/15/2004'],
        ['DateAdd("ww", 2, #1/1/2003#)', 'Date:1/15/2003'],
        ['DateDiff("d", #1/1/2003#, #3/1/2003#)', 'Long:59'],
        ['DateDiff("m", #1/31/2003#, #2/1/2003#)', 'Long:1'],
        ['DateDiff("yyyy", #12/31/2002#, #1/1/2003#)', 'Long:1'],
        ['DateDiff("h", #1/1/2003 1:59#, #1/1/2003 2:01#)', 'Long:1'],
        ['DateDiff("s", #1/1/2003#, #1/1/2003 0:01#)', 'Long:60'],
        ['DateDiff("w", #1/1/2003#, #1/20/2003#)', 'Long:2'],
        ['DateDiff("ww", #1/4/2003#, #1/5/2003#)', 'Long:1'],
        ['DateDiff("d", #3/1/2003#, #1/1/2003#)', 'Long:-59'],
        ['DatePart("q", #8/1/2003#)', 'Integer:3'], ['DatePart("y", #2/1/2003#)', 'Integer:32'],
        ['DatePart("ww", #1/1/2003#)', 'Integer:1'], ['DatePart("ww", #1/5/2003#)', 'Integer:2'],
        ['DatePart("w", #1/2/2003#)', 'Integer:5'],
        ['FormatDateTime(#1/2/2003 4:05:06 PM#)', 'String:1/2/2003 4:05:06 PM'],
        ['FormatDateTime(#1/2/2003 4:05:06 PM#, vbLongDate)', 'String:Thursday, January 02, 2003'],
        ['FormatDateTime(#1/2/2003 4:05:06 PM#, vbShortDate)', 'String:1/2/2003'],
        ['FormatDateTime(#1/2/2003 4:05:06 PM#, vbLongTime)', 'String:4:05:06 PM'],
        ['FormatDateTime(#1/2/2003 4:05:06 PM#, vbShortTime)', 'String:16:05'],
        ['Year("3/4/2001")', 'Integer:2001'], ['Month(Null)', 'Null'],
    ]);
    await errors([
        ['MonthName(13)', 5], ['WeekdayName(0)', 5], ['DateAdd("x", 1, Now)', 5],
        ['Year("nonsense")', 13], ['DateValue("nonsense")', 13],
    ]);
});

test('the Format functions, in the English locale', async()=>{
    await expect([
        ['FormatNumber(1234.5)', 'String:1,234.50'], ['FormatNumber(1234.5, 0)', 'String:1,235'],
        ['FormatNumber(0.5, 2, 0)', 'String:.50'],
        ['FormatNumber(-1234.5, 1, , -1)', 'String:(1,234.5)'],
        ['FormatNumber(1234.5, 1, , , 0)', 'String:1234.5'],
        ['FormatNumber(0.125, 2)', 'String:0.13'],
        ['FormatNumber(-0.001, 2)', 'String:0.00'], ['FormatCurrency(1234.5)', 'String:$1,234.50'],
        ['FormatCurrency(-1234.5)', 'String:($1,234.50)'],
        ['FormatCurrency(-1, 2, , 0)', 'String:-$1.00'],
        ['FormatPercent(0.5)', 'String:50.00%'], ['FormatPercent(-0.25, 0)', 'String:-25%'],
    ]);
});

test('Rnd follows Visual Basic\'s generator; Rnd(0) repeats, a negative seed restarts', async()=>{
    const e = engine();
    await e.run('a = Rnd: b = Rnd: c = Rnd(0): d = Rnd(-1): f = Rnd(-1): t = TypeName(a)');
    assert.equal(e.getGlobal('a').toFixed(7), '0.7055475');
    assert.equal(e.getGlobal('b').toFixed(7), '0.5334240');
    assert.equal(e.getGlobal('c'), e.getGlobal('b'));
    assert.equal(e.getGlobal('d'), e.getGlobal('f'));
    assert.equal(e.getGlobal('t'), 'Single');
    // Randomize with a seed makes the sequence repeatable.
    const sequence = async()=>{
        const r = engine();
        await r.run('Randomize 42: a = Rnd & "," & Rnd');
        return r.getGlobal('a');
    };
    assert.equal(await sequence(), await sequence());
});

test('the RegExp object: Test, Execute, Replace and the Match objects', async()=>{
    const e = engine();
    await e.run(`
        Dim re, out, m, matches
        Set re = New RegExp
        re.Pattern = "(\\w+)@(\\w+)\\.com"
        out = re.Test("mail ann@example.com now") & re.Test("nothing")
        Set matches = re.Execute("ann@example.com, bob@test.com")
        out = out & "|" & matches.Count
        re.Global = True
        Set matches = re.Execute("ann@example.com, bob@test.com")
        out = out & "|" & matches.Count
        For Each m In matches
            out = out & "|" & m.Value & "@" & m.FirstIndex & "+" & m.Length & ":" & m.SubMatches(0)
        Next
        out = out & "|" & matches(1).SubMatches.Count & matches.Item(0)
        out = out & "|" & re.Replace("ann@example.com, bob@test.com", "$2:$1")
        re.Pattern = "A"
        re.IgnoreCase = True
        out = out & "|" & re.Replace("banana", "o") & TypeName(matches) & TypeName(m)
        re.Pattern = "("
        On Error Resume Next
        x = re.Test("a")
        out = out & "|" & Err.Number
    `);
    assert.equal(e.getGlobal('out'), 'TrueFalse|1|2|ann@example.com@0+15:ann'
        + '|bob@test.com@17+12:bob|2ann@example.com|example:ann, test:bob'
        + '|bononoIMatchCollection2IMatch2|5017');
});

test('MsgBox and InputBox go to the embedder, and are refused without one', async()=>{
    await assert.rejects(engine().run('MsgBox "hi"'), e=>e instanceof VBScriptError
        && e.number === 70 && e.description === 'Permission denied');
    /** @type {unknown[][]} */
    const shown = [];
    const e = engine({
        msgBox: (prompt, buttons, title)=>{
            shown.push([prompt, buttons, title]);
            return Promise.resolve(6);
        },
        inputBox: (prompt, title, fallback)=>`${prompt}/${title}/${fallback}`,
    });
    await e.run('r = MsgBox("Go on?", vbYesNo + vbQuestion, "Setup")\nMsgBox "done"\n'
        + 'i = InputBox("Name", , "anon")');
    assert.deepEqual(shown, [['Go on?', 36, 'Setup'], ['done', 0, 'VBScript']]);
    assert.equal(e.getGlobal('r'), 6);
    assert.equal(e.getGlobal('i'), 'Name/VBScript/anon');
});
