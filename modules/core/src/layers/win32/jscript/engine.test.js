/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JScriptError, ScriptAbort, createJScriptEngine } from './engine.js';

/** 8 October 2026, 10:34:56.789 UTC. */
const NOW = Date.UTC(2026, 9, 8, 10, 34, 56, 789);

/** @param {import('./engine.js').JScriptOptions} [options] */
const engine = (options = {})=>createJScriptEngine({
    now: ()=>NOW, localOffset: ()=>0, random: ()=>0.25, ...options,
});

/**
 * Each text's value in a fresh engine.
 *
 * @param {[string, unknown][]} cases
 * @param {import('./engine.js').JScriptOptions} [options]
 */
async function expect(cases, options){
    for (const [text, expected] of cases)
    {
        const value = await engine(options).run(text);
        assert.deepEqual(value, expected, text);
    }
}

/**
 * The error a text fails with.
 *
 * @param {string} text @param {import('./engine.js').JScriptOptions} [options]
 * @returns {Promise<JScriptError>}
 */
async function failure(text, options){
    try
    {
        await engine(options).run(text);
    }
    catch (e){
        assert.ok(e instanceof JScriptError, `${text}: ${e}`);
        return e;
    }
    assert.fail(`${text} did not fail`);
}

/** The signed HRESULT of a JScript error code. @param {number} code */
const hr = code=>(0x800a0000 | code) | 0;

test('typeof, including JScript\'s answers for what it cannot type', async()=>{
    await expect([
        ['typeof undefined', 'undefined'], ['typeof null', 'object'], ['typeof true', 'boolean'],
        ['typeof 1', 'number'], ['typeof ""', 'string'], ['typeof {}', 'object'],
        ['typeof []', 'object'], ['typeof function(){}', 'function'],
        ['typeof new String("")', 'object'], ['typeof Math', 'object'], ['typeof Date', 'function'],
        ['typeof notDeclared', 'undefined'], ['typeof new Date().getVarDate()', 'date'],
    ]);
});

test('type conversions (clause 9) and the operators that use them', async()=>{
    await expect([
        ['"1" == 1', true], ['null == undefined', true], ['null == 0', false], ['"" == 0', true],
        ['"0x10" == 16', true], ['" 12\\n" - 0', 12], ['"1e3" * 1', 1000],
        ['isNaN("abc" * 1)', true], ['isNaN(Number("0b1"))', true], ['Number("")', 0],
        ['String(1e21)', '1e+21'], ['String(0.1)', '0.1'], ['String(-0)', '0'],
        ['1 / 0', Infinity], ['(-1) >>> 0', 4294967295], ['1 << 33', 2], ['-7 % 3', -1],
        ['"3" + 4 + 5', '345'], ['3 + 4 + "5"', '75'], ['[] + {}', '[object Object]'],
        ['true + 1', 2], ['null + 1', 1], ['isNaN(undefined + 1)', true],
        ['"b" > "a"', true], ['"10" < "9"', true], ['10 < "9"', false],
        ['NaN == NaN', false], ['NaN != NaN', true], ['0 === -0', true],
        ['({ valueOf: function(){ return 7 } }) * 2', 14],
        ['"x" + { toString: function(){ return "y" } }', 'xy'],
        ['new Number(5) == 5', true], ['new Number(5) === 5', false],
        ['!!""', false], ['!!"0"', true], ['!!new Boolean(false)', true],
        ['typeof (1, "a")', 'string'], ['void 0', undefined],
        ['1 && 2 || 3', 2], ['0 || null', null], ['true ? "y" : "n"', 'y'],
    ]);
});

test('closures, scope and this', async()=>{
    await expect([
        ['function counter(){ var n = 0; return function(){ return ++n } }'
            + ' var c = counter(); c(); c(); c()', 3],
        ['var fs = []; for (var i = 0; i < 3; i++) fs[i] = function(){ return i };'
            + ' fs[0]() + fs[2]()', 6],
        ['var o = { v: 4, get: function(){ return this.v } }; o.get()', 4],
        ['var g = 9; function f(){ return this.g } f()', 9],
        ['function f(){ return this } f() === this', true],
        ['function f(a, b){ return this.x + a + b }'
            + ' f.call({ x: 1 }, 2, 3) + f.apply({ x: 10 }, [20, 30])', 66],
        ['function P(x){ this.x = x } var p = new P(3); p.x', 3],
        ['function P(){ return { y: 1 } } new P().y', 1],
        ['function f(){ return typeof this } f.call(5)', 'object'],
        ['String.prototype.me = function(){ return typeof this }; "s".me()', 'object'],
        ['var x = 1; function f(){ var x = 2; return x } f() + x', 3],
        ['function f(){ y = 5 } f(); y', 5],
    ]);
});

test('prototypes, constructors and instanceof', async()=>{
    await expect([
        ['function A(){} A.prototype.k = 1; var a = new A(); a.k + (a instanceof A ? 1 : 0)', 2],
        ['function A(){} function B(){} B.prototype = new A(); new B() instanceof A', true],
        ['function A(){} new A().constructor === A', true],
        ['var o = { a: 1 }; o.hasOwnProperty("a") && !o.hasOwnProperty("toString")', true],
        ['Object.prototype.isPrototypeOf({})', true],
        ['[] instanceof Array && !([] instanceof String)', true],
        ['({}).propertyIsEnumerable("toString")', false],
        ['Object.prototype.toString.call([])', '[object Array]'],
        ['Object.prototype.toString.call(new Date(0))', '[object Date]'],
        ['Object.prototype.toString.call(/x/)', '[object RegExp]'],
        ['Object.prototype.toString.call(Math)', '[object Math]'],
    ]);
    assert.equal((await failure('1 instanceof 2')).number, hr(5002));
});

test('exceptions: throw, catch, finally, and JScript\'s error objects', async()=>{
    await expect([
        ['try { throw 5 } catch (e) { e * 2 }', 10],
        ['var log = ""; try { log += "t"; throw 1 } catch (e) { log += "c" }'
            + ' finally { log += "f" } log', 'tcf'],
        ['function f(){ try { return 1 } finally { return 2 } } f()', 2],
        ['function f(){ try { throw 1 } finally { return 3 } } f()', 3],
        ['var n = 0; for (var i = 0; i < 3; i++) { try { continue } finally { n++ } } n', 3],
        ['try { undefinedThing } catch (e) { e.number }', hr(5009)],
        ['try { undefinedThing } catch (e) { e.description }', '\'undefinedThing\' is undefined'],
        ['try { undefinedThing } catch (e) { e instanceof TypeError }', true],
        ['try { null.x } catch (e) { e.number }', hr(5007)],
        ['try { var a; a.b } catch (e) { e.message }', '\'a\' is null or not an object'],
        ['try { (1)() } catch (e) { e.number }', hr(5002)],
        ['try { new Array(-1) } catch (e) { (e instanceof RangeError) + " " + e.number }',
            `true ${hr(5029)}`],
        ['try { eval("a b") } catch (e) { e.name + " " + e.number }', `SyntaxError ${hr(1004)}`],
        ['var e = new Error(5, "five"); e.number + e.description + e.message', '5fivefive'],
        ['var e = new Error("text"); e.number + e.description', '0text'],
        ['new TypeError("t").name', 'TypeError'],
        ['String(new Error("x"))', '[object Error]'],
        ['new RangeError() instanceof Error', true],
        ['try { decodeURIComponent("%") } catch (e) { e.name + e.number }', `URIError${hr(5025)}`],
    ]);
});

test('an uncaught error: number, description, where it happened', async()=>{
    const error = await failure('var a = 1;\n  null.x;');
    assert.equal(error.number, hr(5007));
    assert.equal(error.description, 'Object expected');
    assert.equal(error.line, 1);
    assert.equal(error.column, 2);
    assert.equal(error.lineText, '  null.x;');
    assert.equal(error.syntax, false);
    assert.equal(error.source, 'Microsoft JScript runtime error');
    const thrown = await failure('throw "plain"');
    assert.equal(thrown.number, hr(5022));
    assert.equal(thrown.value, 'plain');
    const custom = await failure('throw new Error(42, "mine")');
    assert.equal(custom.number, 42);
    assert.equal(custom.description, 'mine');
});

test('a syntax error is a compilation error with its position', async()=>{
    const error = await failure('var x = 1;\nvar = 2;');
    assert.equal(error.syntax, true);
    assert.equal(error.number, hr(1010));
    assert.equal(error.description, 'Expected identifier');
    assert.equal(error.source, 'Microsoft JScript compilation error');
    assert.equal(error.line, 1);
    assert.equal(error.column, 4);
});

test('statements: labels, switch, loops, for-in, with, delete', async()=>{
    await expect([
        ['var n = 0; outer: for (var i = 0; i < 3; i++) { for (var j = 0; j < 3; j++)'
            + ' { if (j == 1) continue outer; if (i == 2) break outer; n++ } } n', 2],
        ['var r = ""; switch (2) { case 1: r += "1"; case 2: r += "2"; case 3: r += "3";'
            + ' break; case 4: r += "4" } r', '23'],
        ['var r = ""; switch (9) { case 1: r += "1"; default: r += "d"; case 2: r += "2" } r',
            'd2'],
        ['var r = ""; switch ("1") { case 1: r = "number"; break; default: r = "strict" } r',
            'strict'],
        ['b: { if (true) break b; "not here" }', undefined],
        ['var i = 0; while (true) { if (++i > 4) break } i', 5],
        ['var i = 10; do { i++ } while (false); i', 11],
        ['var s = ""; for (var k in { a: 1, b: 2, c: 3 }) s += k; s', 'abc'],
        ['function P(){ this.own = 1 } P.prototype.inherited = 2; var s = "";'
            + ' for (var k in new P()) s += k; s', 'owninherited'],
        ['var o = { a: 1, b: 2 }, s = ""; for (var k in o) { delete o.b; s += k } s', 'a'],
        ['var s = ""; for (var k in []) s += k; for (var k in "abc") s += k;'
            + ' for (var k in null) s += k; s', ''],
        ['var o = { x: 2 }; with (o) { x = 3; var y = x * 2 } o.x + y', 9],
        ['var v = 1; delete v', false],
        ['implicit = 1; delete implicit', true],
        ['var o = { p: 1 }; delete o.p; "p" in o', false],
        ['delete Math.PI', false],
        ['"length" in []', true],
    ]);
});

test('functions: hoisting, arguments, JScript\'s named function expressions', async()=>{
    await expect([
        ['f(); function f(){ return 1 }', 1],
        ['if (false) { function g(){ return "hoisted" } } g()', 'hoisted'],
        ['function f(){ return arguments.length + arguments[1] } f(1, 2, 3)', 5],
        ['function f(a){ arguments[0] = 9; return a } f(1)', 9],
        ['function f(a){ a = 7; return arguments[0] } f(1)', 7],
        ['function f(){ return arguments.callee === f } f()', true],
        ['function f(a, b){} f.length', 2],
        ['var f = function g(){ return typeof g }; f()', 'function'],
        ['var f = function g(){}; typeof g', 'function'],
        ['var f = function g(){}; f === g', false],
        ['(function(){ return 3 })()', 3],
        ['String(function f(){ return 1 })', 'function f(){ return 1 }'],
        ['String(Math.max)', '\nfunction max() {\n    [native code]\n}\n'],
        ['new Function("a", "b", "return a * b")(6, 7)', 42],
        ['String(new Function("x", "return x"))', 'function anonymous(x) {\nreturn x\n}'],
    ]);
});

test('eval: in the caller\'s scope, its vars deletable, its value the last statement\'s',
    async()=>{
        await expect([
            ['function f(){ var local = 3; return eval("local * 2") } f()', 6],
            ['eval("var made = 4"); made', 4],
            ['eval("var gone = 1"); delete gone', true],
            ['eval("1; if (true) { 2 }")', 2],
            ['eval("function inner(){ return 5 }"); inner()', 5],
            ['eval(7)', 7],
            ['var e = eval; function f(){ var q = 1; return e("typeof q") } f()', 'undefined'],
        ]);
    });

test('arrays (15.4), JScript\'s splice and unshift', async()=>{
    await expect([
        ['[1, 2, 3].length', 3], ['[1, 2, ].length', 3], ['[,].length', 2],
        ['var a = [1, 2, 3]; a.length = 1; a.join()', '1'],
        ['var a = []; a[5] = 1; a.length', 6],
        ['var a = [1]; a.push(2, 3) + a.join("-")', '31-2-3'],
        ['var a = [1, 2]; a.pop() + a.length', 3],
        ['var a = [1, 2]; a.shift() * 10 + a[0]', 12],
        ['var a = [2]; typeof a.unshift(1) + a.join()', 'undefined1,2'],
        ['[1, 2, 3, 4].slice(1, -1).join()', '2,3'],
        ['var a = [1, 2, 3, 4]; a.splice(1, 2, "x").join() + "|" + a.join()', '2,3|1,x,4'],
        ['var a = [1, 2, 3]; a.splice(1).length + "|" + a.join()', '0|1,2,3'],
        ['[1, [2, 3]].concat(4, [5]).length', 4],
        ['[1, 2, 3].reverse().join()', '3,2,1'],
        ['[10, 9, 1].sort().join()', '1,10,9'],
        ['[10, 9, 1].sort(function(a, b){ return a - b }).join()', '1,9,10'],
        ['var a = [3, undefined, 1]; a.sort(); a[2] === undefined && a.join()', '1,3,'],
        ['[null, undefined, 1].join()', ',,1'],
        ['String([1, [2, 3]])', '1,2,3'],
        ['new Array(3).length', 3], ['new Array(1, 2).length', 2], ['Array(2, 3)[1]', 3],
        ['[1, 2].toString === Array.prototype.toString', true],
        ['typeof [].indexOf', 'undefined'],
    ]);
});

test('strings (15.5), JScript\'s substr and missing indexing', async()=>{
    await expect([
        ['"abc".length', 3], ['"abc".charAt(1)', 'b'], ['"abc".charCodeAt(0)', 97],
        ['isNaN("abc".charCodeAt(5))', true], ['"abc"[0]', undefined],
        ['"hello".indexOf("l")', 2], ['"hello".lastIndexOf("l")', 3],
        ['"hello".indexOf("z")', -1], ['"hello".substring(3, 1)', 'el'],
        ['"hello".substr(1, 3)', 'ell'], ['"hello".substr(-2)', 'hello'],
        ['"hello".slice(-3, -1)', 'll'], ['"a,b,c".split(",").length', 3],
        ['"abc".split("").join("|")', 'a|b|c'], ['"a,b".split(",", 1).length', 1],
        ['"Hi".toUpperCase() + "Hi".toLowerCase()', 'HIhi'],
        ['"a".concat("b", 1)', 'ab1'], ['String.fromCharCode(72, 105)', 'Hi'],
        ['"b".localeCompare("a")', 1], ['"x".bold() + "y".link("u")', '<B>x</B><A HREF="u">y</A>'],
        ['typeof "x".trim', 'undefined'], ['new String("ab").length', 2],
    ]);
});

test('regular expressions (15.10) and JScript\'s differences', async()=>{
    await expect([
        ['/b+/.test("abbc")', true], ['/x/i.test("X")', true],
        ['var m = /(\\d+)-(\\d+)/.exec("on 12-34 ."); m[0] + "|" + m[1] + "|" + m.index',
            '12-34|12|3'],
        ['var m = /(a)|(b)/.exec("b"); m[1] === "" && m[2]', 'b'],
        ['/(a)(b)/.exec("ab"); RegExp.$1 + RegExp.$2 + RegExp.lastMatch', 'abab'],
        ['var r = /o/g, s = "foo", n = 0; while (r.exec(s)) n++; n', 2],
        ['var r = /x*/g, n = 0; while (r.exec("ab") && n < 10) n++; n', 3],
        ['var r = /a/; r.exec("ba"); r.lastIndex', 2],
        ['"aXbXc".replace(/X/g, "-")', 'a-b-c'], ['"aXbX".replace("X", "-")', 'a-bX'],
        ['"john smith".replace(/(\\w+)\\s(\\w+)/, "$2, $1")', 'smith, john'],
        ['"abc".replace(/b/, "[$&$`$\']")', 'a[bac]c'],
        ['"a1b2".replace(/\\d/g, function(d){ return d * 2 })', 'a2b4'],
        ['"one two".match(/\\w+/g).join()', 'one,two'], ['"abc".match(/z/g)', null],
        ['"abc".search(/c/)', 2],
        ['",a,,b,".split(/,/).join("|")', 'a|b'], ['"a1b".split(/(\\d)/).join("|")', 'a|b'],
        ['String(/a\\/b/gim)', '/a\\/b/gim'], ['/x/g.global && !/x/.ignoreCase', true],
        ['new RegExp("a+", "g").source', 'a+'],
        ['function f(){ return /r/ } f() === f()', true],
        ['var a = []; for (var i = 0; i < 2; i++) a[i] = /r/; a[0] === a[1]', true],
    ]);
    const error = await failure('new RegExp("(")');
    assert.equal(error.number, hr(5017));
    assert.equal((await failure('new RegExp("a", "gg")')).number, hr(5017));
});

test('numbers and Math (15.7, 15.8)', async()=>{
    await expect([
        ['(1.005).toFixed(2)', '1.00'], ['(255).toString(16)', 'ff'], ['(5).toString(2)', '101'],
        ['(1234.5678).toExponential(2)', '1.23e+3'], ['(1234.5678).toPrecision(6)', '1234.57'],
        ['(1234567.891).toLocaleString()', '1,234,567.89'], ['Number.MAX_VALUE > 1e308', true],
        ['Math.floor(-1.5)', -2], ['Math.round(2.5)', 3], ['1 / Math.round(-0.4)', -Infinity],
        ['Math.max()', -Infinity], ['isNaN(Math.max(1, NaN))', true], ['Math.pow(2, 10)', 1024],
        ['Math.random()', 0.25], ['Math.abs(-3)', 3], ['Math.PI > 3.14', true],
        ['parseInt("010")', 8], ['parseInt("0x1f")', 31], ['parseInt("12px")', 12],
        ['parseInt("08")', 0], ['parseInt("11", 2)', 3], ['isNaN(parseInt("z"))', true],
        ['parseFloat("3.5e1x")', 35], ['parseFloat("  -.5")', -0.5], ['isFinite("12")', true],
        ['escape("a b+c\\u0100")', 'a%20b+c%u0100'], ['unescape("%41%u0042")', 'AB'],
        ['encodeURIComponent("a b&")', 'a%20b%26'], ['decodeURI("%41")', 'A'],
    ]);
    assert.equal((await failure('(1).toFixed(21)')).number, hr(5026));
    assert.equal((await failure('(1).toPrecision(0)')).number, hr(5027));
    assert.equal((await failure('Number.prototype.toString.call("x")')).number, hr(5001));
});

test('dates (15.9) on the machine\'s clock and zone, in JScript\'s text forms', async()=>{
    await expect([
        ['new Date().getTime()', NOW],
        ['new Date(2000, 0, 31).getMonth()', 0],
        ['var d = new Date(2000, 0, 31); d.setMonth(1); d.getMonth() + "/" + d.getDate()', '2/2'],
        ['Date.UTC(2000, 1, 29)', Date.UTC(2000, 1, 29)],
        ['new Date(0).toUTCString()', 'Thu, 1 Jan 1970 00:00:00 UTC'],
        ['new Date(2000, 0, 31).toString()', 'Mon Jan 31 00:00:00 UTC 2000'],
        ['new Date(2000, 0, 31, 13, 5).toLocaleString()', 'Monday, January 31, 2000 1:05:00 PM'],
        ['new Date(2000, 0, 31).toDateString()', 'Mon Jan 31 2000'],
        ['new Date(99, 0, 1).getFullYear()', 1999],
        ['new Date(1999, 5, 1).getYear() + new Date(2000, 5, 1).getYear()', 99 + 2000],
        ['Date.parse("Jan 31 2000 10:00:00 UTC")', Date.UTC(2000, 0, 31, 10)],
        ['Date.parse("1/31/2000")', Date.UTC(2000, 0, 31)],
        ['Date.parse("Mon, 31 Jan 2000 01:02:03 GMT-0130")', Date.UTC(2000, 0, 31, 2, 32, 3)],
        ['Date.parse("Jan 1 2000 3:00 PM")', Date.UTC(2000, 0, 1, 15)],
        ['Date.parse(new Date(NaN).toString())', NaN],
        ['String(new Date(NaN))', 'NaN'], ['typeof Date()', 'string'],
        ['new Date(new Date(2000, 0, 31, 6).getVarDate()).getHours()', 6],
        ['new Date(1e20).getTime()', NaN],
    ]);
    const east = { localOffset: ()=>2 * 3600000 };
    await expect([
        ['new Date(0).toString()', 'Thu Jan 1 02:00:00 UTC+0200 1970'],
        ['new Date(0).getTimezoneOffset()', -120],
        ['new Date(1970, 0, 1, 2).getTime()', 0],
        ['Date.parse(new Date(5000).toString())', 5000],
    ], east);
    assert.equal((await failure('Date.prototype.getTime.call({})')).number, hr(5006));
});

test('JScript\'s own: version functions, conditional compilation, CollectGarbage', async()=>{
    await expect([
        ['ScriptEngine() + ScriptEngineMajorVersion() + ScriptEngineMinorVersion()'
            + ' + ScriptEngineBuildVersion()', 'JScript568835'],
        ['/*@cc_on @*/ /*@if (@_jscript) "jscript" @else @*/ "other" /*@end @*/', 'jscript'],
        ['var isIE = /*@cc_on!@*/false; isIE', true],
        ['/*@cc_on @_jscript_version @*/', 5.6],
        ['CollectGarbage()', undefined],
    ]);
    await expect([['ScriptEngineMinorVersion()', 7]],
        { version: { major: 5, minor: 7, build: 18000 } });
    const kept = engine();
    await kept.run('/*@cc_on @set @mine = 3 @*/');
    assert.equal(await kept.run('/*@cc_on @mine @*/'), 3);
});

test('global code\'s functions and vars become the global object\'s; call() calls them',
    async()=>{
        const script = engine();
        await script.run('var total = 1; function add(a, b){ return a + b + total }');
        assert.equal(await script.call('add', [2, 3]), 6);
        assert.equal(script.global.get('total'), 1);
        await assert.rejects(script.call('missing'), e=>e instanceof JScriptError
            && e.number === hr(5009));
        await assert.rejects(script.call('total'), e=>e instanceof JScriptError
            && e.number === hr(5002));
        assert.equal(await script.run('6 * 7', { expression: true }), 42);
    });

test('a runaway script is the embedder\'s to stop, at a checkpoint', async()=>{
    let checks = 0;
    const stopping = engine({
        checkpoint: ()=>{
            if (++checks === 3)
            {
                throw new ScriptAbort('too long');
            }
        },
    });
    await assert.rejects(stopping.run('while (true) {}'), e=>e instanceof ScriptAbort);
    // A try in the script cannot catch the stop.
    checks = 0;
    await assert.rejects(stopping.run('try { for (;;) {} } catch (e) {} "caught"'),
        e=>e instanceof ScriptAbort);
    const waiting = engine({ checkpoint: ()=>new Promise(done=>setImmediate(done)) });
    assert.equal(await waiting.run('var n = 0; for (var i = 0; i < 20000; i++) n++; n'), 20000);
    const interrupted = engine({
        checkpoint: ()=>{
            interrupted.interrupt('host said stop');
        },
    });
    await assert.rejects(interrupted.run('for (;;) {}'), e=>e instanceof ScriptAbort
        && e.message === 'host said stop');
});

test('deep recursion is error 28, which a script can catch', async()=>{
    await expect([
        ['function f(){ return f() } try { f() } catch (e) { e.number }', hr(28)],
    ]);
});

test('the host\'s Date and globals are not the script\'s', async()=>{
    await expect([
        ['typeof process', 'undefined'], ['typeof require', 'undefined'],
        ['typeof globalThis', 'undefined'], ['typeof window', 'undefined'],
        ['this.constructor === Object', true],
        ['typeof (function(){ return this })().setTimeout', 'undefined'],
    ]);
});
