/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScriptAbort, ScriptError } from '../script/engine.js';
import { VBScriptError, createVBScriptEngine } from './engine.js';

/** 8 October 2026, 10:34:56.789 UTC. */
const NOW = Date.UTC(2026, 9, 8, 10, 34, 56, 789);

/** @param {import('./engine.js').VBScriptOptions} [options] */
const engine = (options = {})=>createVBScriptEngine({ now: ()=>NOW, localOffset: ()=>0,
    ...options });

/**
 * Each expression's value in a fresh engine.
 *
 * @param {[string, unknown][]} cases
 */
async function expect(cases){
    for (const [text, expected] of cases)
    {
        assert.deepEqual(await engine().run(text, { expression: true }), expected, text);
    }
}

/**
 * What a program left in its variable `out`.
 *
 * @param {string} text @param {import('./engine.js').VBScriptOptions} [options]
 */
async function output(text, options){
    const e = engine(options);
    await e.run(text);
    return e.getGlobal('out');
}

/**
 * The error a text fails with.
 *
 * @param {string} text @param {import('./engine.js').VBScriptOptions} [options]
 * @returns {Promise<VBScriptError>}
 */
async function failure(text, options){
    try
    {
        await engine(options).run(text);
    }
    catch (e){
        assert.ok(e instanceof VBScriptError, `${text}: ${e}`);
        return e;
    }
    assert.fail(`${text} did not fail`);
}

test('literals keep VBScript\'s subtypes, and operators widen them as VarAdd does', async()=>{
    await expect([
        ['TypeName(1)', 'Integer'], ['TypeName(32767)', 'Integer'], ['TypeName(32768)', 'Long'],
        ['TypeName(2147483648)', 'Double'], ['TypeName(1.0)', 'Double'],
        ['TypeName(&HFF)', 'Integer'],
        ['&HFFFF', -1], ['&HFFFF&', 65535], ['&H10000', 65536], ['&O17', 15], ['&17', 15],
        ['TypeName(1 + 1)', 'Integer'], ['TypeName(32767 + 1)', 'Long'],
        ['TypeName(2147483647 + 1)', 'Double'], ['TypeName(1 + 1.5)', 'Double'],
        ['TypeName(1 + "1")', 'Double'], ['1 + "1"', 2], ['"1" + "1"', '11'],
        ['TypeName(True + True)', 'Integer'], ['True + True', -2],
        ['TypeName(Empty + Empty)', 'Integer'],
        ['Empty + "a"', 'a'], ['IsNull(Null + 1)', true], ['TypeName(10 / 2)', 'Double'],
        ['TypeName(CByte(1) + CByte(2))', 'Byte'], ['TypeName(CByte(200) + CByte(100))', 'Integer'],
        ['TypeName(-32768)', 'Long'], ['TypeName(#1/2/2003# + 1)', 'Date'],
        ['TypeName(#1/2/2003# - #1/1/2003#)', 'Double'], ['#1/2/2003# - #1/1/2003#', 1],
        ['7 \\ 2', 3], ['-7 \\ 2', -3], ['7.5 \\ 2', 4], ['TypeName(7 \\ 2)', 'Integer'],
        ['-7 Mod 3', -1], ['5 Mod 2.5', 1], ['2 ^ 10', 1024], ['TypeName(2 ^ 2)', 'Double'],
        ['-2 ^ 2', -4], ['2 ^ -1', 0.5], ['2 * 3 + 4', 10], ['2 + 3 * 4', 14], ['(2 + 3) * 4', 20],
        ['10 - 2 - 3', 5], ['2 ^ 3 ^ 2', 64], ['1 + 2 & 3', '33'], ['"a" & 1 & True', 'a1True'],
        ['Null & "x"', 'x'], ['IsNull(Null & Null)', true], ['Empty & "x"', 'x'],
    ]);
});

test('comparisons: numbers by value, text by code unit, a number below any text', async()=>{
    await expect([
        ['1 = 1.0', true], ['1 < 2', true], ['"a" < "b"', true], ['"a" = "A"', false],
        ['"B" < "a"', true], ['"10" < "9"', true], ['10 < "9"', true], ['"1" = 1', false],
        ['True = -1', true], ['Empty = 0', true], ['Empty = ""', true],
        ['IsNull(Null = Null)', true],
        ['IsNull(1 < Null)', true], ['#1/2/2003# > #1/1/2003#', true], ['1 <> 2', true],
        ['3 >= 3', true], ['3 <= 2', false], ['Not 1 = 2', true],
    ]);
});

test('logical operators are bitwise on numbers and three-valued on Null', async()=>{
    await expect([
        ['True And False', false], ['True Or False', true], ['True Xor True', false],
        ['True Eqv False', false], ['False Imp False', true], ['True Imp False', false],
        ['Not 0', -1], ['Not True', false], ['TypeName(Not 1)', 'Integer'], ['6 And 3', 2],
        ['6 Or 3', 7], ['6 Xor 3', 5], ['False And Null', false], ['IsNull(True And Null)', true],
        ['True Or Null', true], ['IsNull(False Or Null)', true], ['IsNull(Null Xor True)', true],
        ['False Imp Null', true], ['IsNull(True Imp Null)', true], ['Null Imp True', true],
        ['TypeName(True And 5)', 'Integer'], ['TypeName(CLng(1) And 1)', 'Long'],
    ]);
});

test('Dim, Const, ReDim Preserve, Erase and multi-dimensional arrays', async()=>{
    assert.equal(await output(`
        Dim a(2), m(1, 2), d(), out
        Const LIMIT = 3, NAME = "n", NEG = -2
        a(0) = "x": a(2) = "z"
        m(1, 2) = "corner"
        out = UBound(a) & LBound(a) & UBound(m, 1) & UBound(m, 2) & m(1, 2) & a(0) & a(1) & a(2)
        ReDim d(1): d(0) = "keep": d(1) = "too"
        ReDim Preserve d(LIMIT)
        out = out & "|" & UBound(d) & d(0) & d(1) & IsEmpty(d(3))
        ReDim d(1)
        out = out & "|" & IsEmpty(d(0)) & NAME & NEG
        Erase a
        out = out & "|" & UBound(a) & IsEmpty(a(0))
        Dim b: b = Array(1, 2): Dim c: c = b: c(0) = 9
        out = out & "|" & b(0) & c(0) & IsArray(b) & TypeName(b)
    `), '2012cornerxz|3keeptooTrue|Truen-2|2True|19TrueVariant()');
    assert.equal((await failure('Dim a(2)\na(3) = 1')).number, 9);
    assert.equal((await failure('Dim a(2)\nReDim a(4)')).number, 10);
    assert.equal((await failure('Dim m()\nReDim m(1, 1)\nReDim Preserve m(2, 1)')).number, 9);
    assert.equal((await failure('Const C = 1\nC = 2')).number, 501);
    assert.equal((await failure('Dim d()\nx = UBound(d)')).number, 9);
    assert.equal((await failure('x = UBound(5)')).number, 13);
});

test('Option Explicit refuses an undeclared name; without it a name declares itself',
    async()=>{
        assert.equal(await output('out = 1\nundeclared = out + 1\nout = undeclared'), 2);
        const error = await failure('Option Explicit\nDim a\na = 1\nb = 2');
        assert.equal(error.number, 500);
        assert.equal(error.description, 'Variable is undefined');
        assert.equal(error.line, 3);
        assert.equal((await failure('Option Explicit\nx = y')).number, 500);
        // A Dim further down still declares the name for the lines above.
        assert.equal(await output('Option Explicit\nout = 5\nDim out'), 5);
    });

test('Sub and Function, by reference and by value', async()=>{
    assert.equal(await output(`
        Dim out, n, a(1)
        Sub Inc(x): x = x + 1: End Sub
        Sub Keep(ByVal x): x = x + 1: End Sub
        Function Twice(x)
            Twice = x * 2
        End Function
        Function Fact(k)
            If k <= 1 Then Fact = 1 Else Fact = k * Fact(k - 1)
        End Function
        n = 1
        Inc n: out = n
        Keep n: out = out & n
        Inc (n): out = out & n
        Call Inc(n): out = out & n
        a(0) = 10: Inc a(0): out = out & "|" & a(0)
        out = out & "|" & Twice(21) & "|" & Fact(10) & "|" & TypeName(Twice(1))
        Function Early(v)
            Early = "set"
            If v Then Exit Function
            Early = "late"
        End Function
        out = out & "|" & Early(True) & Early(False)
    `), '2223|11|42|3628800|Integer|setlate');
    assert.equal((await failure('Sub S(a): End Sub\nS 1, 2')).number, 450);
    assert.equal((await failure('Sub S(a): End Sub\nS(1, 2)')).number, 1044);
    assert.equal((await failure('Undefined 1')).number, 13);
    assert.equal((await failure('x = Undefined(1)')).number, 13);
});

test('classes: fields, properties, Default, Me, New, Set, Nothing and Is', async()=>{
    assert.equal(await output(`
        Class Account
            Public Owner
            Private mBalance
            Private Sub Class_Initialize()
                mBalance = 100
            End Sub
            Public Property Get Balance
                Balance = mBalance
            End Property
            Public Property Let Balance(value)
                mBalance = value
            End Property
            Public Property Set Partner(value)
                Set mPartner = value
            End Property
            Public Property Get Partner
                Set Partner = mPartner
            End Property
            Private mPartner
            Public Default Function Deposit(amount)
                mBalance = mBalance + amount
                Deposit = Me.Balance
            End Function
            Public Function Self()
                Set Self = Me
            End Function
        End Class
        Dim out, a, b
        Set a = New Account
        a.Owner = "ann"
        a.Balance = 5
        out = a.Owner & a.Balance & "|" & a(10) & "|" & a.Deposit(1) & "|" & a.Deposit(1)
        Set b = New Account
        Set a.Partner = b
        out = out & "|" & (a.Partner Is b) & (a Is b) & (a.Self Is a) & (a.Partner Is Nothing)
        out = out & "|" & TypeName(a) & IsObject(a) & IsObject(Nothing) & TypeName(Nothing)
        Set b = Nothing
        out = out & "|" & (b Is Nothing)
    `), 'ann5|15|16|17|TrueFalseTrueFalse|AccountTrueTrueNothing|True');
    assert.equal((await failure('Class C\nPrivate x\nEnd Class\nSet o = New C\no.x = 1')).number,
        438);
    assert.equal((await failure('Class C\nEnd Class\nSet o = New C\ny = o.Missing')).number, 438);
    assert.equal((await failure('Set o = New Missing')).number, 506);
    assert.equal((await failure('Dim o\nx = o.Name')).number, 424);
    assert.equal((await failure('Set o = Nothing\nx = o.Name')).number, 91);
    assert.equal((await failure('Set x = 5')).number, 424);
    assert.equal((await failure('Class C\nEnd Class\nSet o = New C\nx = o + 1')).number, 438);
});

test('Class_Terminate runs when the last reference goes', async()=>{
    assert.equal(await output(`
        Dim out
        Class T
            Public Name
            Private Sub Class_Initialize: out = out & "i": End Sub
            Private Sub Class_Terminate: out = out & "t" & Name: End Sub
        End Class
        Function Make(n)
            Set Make = New T
            Make.Name = n
        End Function
        Dim a, b
        Set a = New T: a.Name = "A"
        Set b = a
        Set a = Nothing
        out = out & "1"
        Set b = Nothing
        out = out & "2"
        Sub Scope
            Dim local: Set local = New T: local.Name = "L"
        End Sub
        Scope
        out = out & "3"
        x = TypeName(New T)
        out = out & "4"
        Set a = Make("M")
        out = out & "5"
        Set a = Make("N")
        out = out & "6"
        Dim list: list = Array(New T)
        list(0).Name = "E"
        list = Empty
        out = out & "7"
    `), 'i1tA2itL3it4i5itM6itE7');
    // Closing the engine terminates what is left.
    const e = engine();
    await e.run('Class T\nPrivate Sub Class_Terminate: done = True: End Sub\nEnd Class\n'
        + 'Dim done, keep\nSet keep = New T');
    assert.equal(e.getGlobal('done'), undefined);
    await e.close();
    assert.equal(e.getGlobal('done'), true);
});

test('If, ElseIf, Else; Select Case with lists, ranges and Is', async()=>{
    assert.equal(await output(`
        Dim out
        Function Kind(n)
            If n < 0 Then
                Kind = "neg"
            ElseIf n = 0 Then
                Kind = "zero"
            Else
                Kind = "pos"
            End If
        End Function
        Function Bucket(v)
            Select Case v
                Case 1, 2: Bucket = "small"
                Case 3 To 5
                    Bucket = "mid"
                Case "x": Bucket = "text"
                Case Is > 100: Bucket = "huge"
                Case Else: Bucket = "other"
            End Select
        End Function
        out = Kind(-1) & Kind(0) & Kind(1)
        out = out & "|" & Bucket(2) & Bucket(4) & Bucket(200) & Bucket("x") & Bucket(50)
        If out <> "" Then out = out & "|one" Else out = out & "|two"
        If False Then out = out & "no" Else If True Then out = out & "|nested"
        If Null Then out = out & "null"
    `), 'negzeropos|smallmidhugetextother|one|nested');
});

test('For, For Each, Do, While and Exit', async()=>{
    assert.equal(await output(`
        Dim out, i, j, item
        For i = 10 To 1 Step -3: out = out & i & ",": Next
        out = out & "after" & i
        For i = 1 To 2 Step 0.5: out = out & "|" & i: Next
        For Each item In Array("a", "b", "c")
            If item = "c" Then Exit For
            out = out & item
        Next
        i = 0
        Do While i < 3: i = i + 1: Loop
        out = out & "|" & i
        Do: i = i - 1: Loop Until i = 0
        out = out & i
        Do Until i = 2: i = i + 1: Loop
        Do
            i = i + 1
            If i = 5 Then Exit Do
        Loop While True
        out = out & i
        While i > 0: i = i - 2: Wend
        out = out & i
        For i = 1 To 3
            For j = 1 To 3
                If j = 2 Then Exit For
                out = out & i & j
            Next
        Next
        Dim m(1, 1): m(0, 0) = 1: m(1, 0) = 2: m(0, 1) = 3: m(1, 1) = 4
        For Each item In m: out = out & "." & item: Next
    `), '10,7,4,1,after-2|1|1.5|2ab|305-1112131.1.2.3.4');
    assert.equal((await failure('For Each x In 5\nNext')).number, 451);
});

test('With reaches the members of its object', async()=>{
    assert.equal(await output(`
        Class P: Public Name, Age: End Class
        Dim out, p: Set p = New P
        With p
            .Name = "x"
            .Age = 3
            out = .Name & .Age
            With New P
                .Name = "inner"
                out = out & .Name
            End With
            out = out & .Name
        End With
    `), 'x3innerx');
});

test('On Error Resume Next, Err, and errors leaving a procedure', async()=>{
    assert.equal(await output(`
        Dim out, x
        On Error Resume Next
        x = 1 / 0
        out = Err.Number & "|" & Err.Description & "|" & Err.Source
        Err.Clear
        out = out & "|" & Err.Number & Err.Description
        Err.Raise 5
        out = out & "|" & Err.Number & ":" & Err.Description
        Err.Raise vbObjectError + 1, "Mine", "custom"
        out = out & "|" & Err.Number & ":" & Err.Source & ":" & Err.Description
        Err.Raise 1234
        out = out & "|" & Err.Description
        If 1 / 0 = 1 Then out = out & "|quirk"
        Err.Clear
        Sub Inner
            Err.Raise 13
            out = out & "never"
        End Sub
        Sub Outer
            On Error Resume Next
            Inner
            out = out & "|after " & Err.Number
        End Sub
        Outer
        x = Err
        On Error GoTo 0
        out = out & "|" & Err.Number & "|" & x
    `), '11|Division by zero|Microsoft VBScript runtime error|0|5:Invalid procedure call or '
        + 'argument|-2147221503:Mine:custom|Unknown runtime error|quirk|after 13|0|13');
    const error = await failure('x = 1\n\nSub S\n  y = Mid("a", 0)\nEnd Sub\nS');
    assert.equal(error.number, 5);
    assert.equal(error.line, 3);
    assert.equal(error.column, 2);
    assert.equal(error.lineText, '  y = Mid("a", 0)');
    assert.equal(error.source, 'Microsoft VBScript runtime error');
    assert.equal(error.scode, 0x800a0005 | 0);
    assert.ok(error instanceof ScriptError);
    const raised = await failure('Err.Raise vbObjectError + 513, "Src", "Mine"');
    assert.equal(raised.number, -2147220991);
    assert.equal(raised.scode, -2147220991);
    assert.equal(raised.source, 'Src');
});

test('compilation errors carry their number, position and line', async()=>{
    /** @type {[string, number, number, number][]} text, number, line, column */
    const cases = [
        ['x = ', 1023, 0, 4], ['If x Then\ny = 1', 1014, 1, 5], ['x = "open', 1033, 0, 4],
        ['For i = 1 To 2\n', 1020, 1, 0], ['x = 1 2', 1025, 0, 6], ['Exit Do', 1039, 0, 5],
        ['Sub A: End Sub\nSub A: End Sub', 1041, 1, 4],
        ['Property Get X: End Property', 1048, 0, 0],
        ['x = @', 1032, 0, 4], ['Do\nLoop Until', 1023, 1, 10],
        ['Function F(a\nEnd Function', 1006, 0, 12],
        ['Class C\nPrivate Default Function F: End Function\nEnd Class', 1057, 1, 8],
        ['x = Me', 1037, 0, 4],
    ];
    for (const [text, number, line, column] of cases)
    {
        const error = await failure(text);
        assert.deepEqual([error.number, error.line, error.column, error.syntax, error.source],
            [number, line, column, true, 'Microsoft VBScript compilation error'], text);
        assert.equal(error.scode, (0x800a0000 | number) | 0);
    }
});

test('Execute, ExecuteGlobal, Eval and GetRef', async()=>{
    assert.equal(await output(`
        Dim out, x
        x = 2
        out = Eval("x * 3") & "|" & Eval("x = 2")
        Sub Local
            Execute "Dim y: y = 7: x = x + y"
            out = out & "|" & y
        End Sub
        Local
        out = out & "|" & x
        ExecuteGlobal "Function Added(n): Added = n + 100: End Function"
        out = out & "|" & Added(1)
        Function Twice(n): Twice = n * 2: End Function
        Dim f: Set f = GetRef("Twice")
        out = out & "|" & f(21) & TypeName(f)
    `), '6|True|7|9|101|42Object');
    const error = await failure('x = Eval("1 +")');
    assert.equal(error.number, 1023);
    assert.equal(error.source, 'Microsoft VBScript compilation error');
    assert.equal((await failure('Set f = GetRef("Nope")')).number, 5);
});

test('ScriptEngine names itself VBScript 5.7', async()=>{
    await expect([
        ['ScriptEngine', 'VBScript'], ['ScriptEngineMajorVersion', 5],
        ['ScriptEngineMinorVersion', 7], ['ScriptEngineBuildVersion', 18066],
        ['TypeName(ScriptEngineMajorVersion)', 'Long'],
    ]);
});

test('lines continue with _, statements separate with :, comments are skipped', async()=>{
    assert.equal(await output(`out = 1 + _
        2 : out = out * 2 ' doubled
        Rem a whole line of remark
        out = out & "" : Rem and one after a colon`), '6');
});

test('call answers a procedure\'s value plainly; run an expression\'s', async()=>{
    const e = engine();
    await e.run('Function Add(a, b): Add = a + b: End Function\n'
        + 'Function Pair(): Pair = Array(1, "two"): End Function\n'
        + 'Function Nothingness(): Set Nothingness = Nothing: End Function');
    assert.equal(await e.call('Add', [2, 3]), 5);
    assert.equal(await e.call('add', ['2', 3]), 5);
    const pair = await e.call('Pair');
    assert.deepEqual(pair.value.items, [1, 'two']);
    assert.equal(await e.call('Nothingness'), null);
    assert.equal(await e.run('CDate("1/2/2003")', { expression: true }).then(v=>v.value), 37623);
    await assert.rejects(e.call('Missing'), err=>err instanceof VBScriptError && err.number === 13);
});

test('an embedder stops a runaway script; the stop is no script\'s to catch', async()=>{
    let checks = 0;
    const e = engine({ checkpoint: ()=>{
        checks++;
        if (checks === 3)
        {
            throw new ScriptAbort('enough');
        }
    } });
    await assert.rejects(e.run('On Error Resume Next\nDo: x = x + 1: Loop'),
        err=>err instanceof ScriptAbort && err.message === 'enough');
    const waiting = engine({ checkpoint: ()=>new Promise(done=>setImmediate(done)) });
    const run = waiting.run('Do: x = x + 1: Loop');
    setImmediate(()=>waiting.interrupt('stop'));
    await assert.rejects(run, err=>err instanceof ScriptAbort);
});

test('deep recursion is out of stack space, a catchable error', async()=>{
    assert.equal(await output(`
        Function Down(n): Down = Down(n + 1): End Function
        On Error Resume Next
        x = Down(0)
        out = Err.Number
    `), 28);
});
