/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, Version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROGRAM_LIMITS, parseProgram } from './arb-program.js';

/**
 * A parsed program, or the test fails with the refusal's message.
 *
 * @param {string} text
 */
function parsed(text){
    const result = parseProgram(text);
    if ('error' in result)
    {
        assert.fail(`the program was refused at ${result.error.position}: ${result.error.message}`);
    }
    return result;
}

test('the header decides the kind, and only the two ARB headers load', ()=>{
    assert.equal(parsed('!!ARBvp1.0\nEND\n').kind, 'vertex');
    assert.equal(parsed('!!ARBfp1.0\nEND\n').kind, 'fragment');
    const wrong = parseProgram('!!ARBvp2.0\nEND\n');
    assert.ok('error' in wrong);
    assert.equal(wrong.error.position, 0);
    const none = parseProgram('MOV result.position, vertex.position;\nEND\n');
    assert.ok('error' in none);
    assert.equal(none.error.position, 0);
});

test('a literal written without braces is a scalar source, the way a driver takes it', ()=>{
    // A program of this era writes `MOV R1.y, 0.2;` and `MOV R1.w, 1;`, which
    // is `{ 0.2 }` written short. Refused, the whole program fails to load --
    // "a source register was expected", at the literal's own position -- and
    // the material that needed the program draws nothing at all.
    const program = parsed(`
        !!ARBfp1.0
        TEMP r1;
        MOV r1.y, 0.2;
        MOV r1.w, 1;
        MUL r1, r1, 2;
        END
        `);
    assert.equal(program.instructions.length, 3);
    /** @param {any} operand @returns {number[]} the literal's four components */
    function literal(operand){
        return /** @type {any} */(operand.binding).values;
    }
    const [toY, toW, scaled] = program.instructions;
    assert.equal(toY.src[0].binding?.kind, 'constant');
    assert.deepEqual(literal(toY.src[0]), [0.2, 0.2, 0.2, 0.2],
        'the value is every component, which is what a scalar source is');
    assert.deepEqual(literal(toW.src[0]), [1, 1, 1, 1]);
    assert.deepEqual(literal(scaled.src[1]), [2, 2, 2, 2]);

    // A sign in front of it negates it like any other source, and a braced
    // constant is unchanged.
    const negated = parsed('!!ARBfp1.0\nTEMP r1;\nMOV r1, -0.5;\nEND\n');
    assert.deepEqual(negated.instructions[0].src[0].components, ['-x', '-y', '-z', '-w'],
        'the sign rides on the components, the way it does for every other source');
    assert.deepEqual(literal(negated.instructions[0].src[0]), [0.5, 0.5, 0.5, 0.5]);
    const braced = parsed('!!ARBfp1.0\nTEMP r1;\nMOV r1, {0.5};\nEND\n');
    assert.deepEqual(literal(braced.instructions[0].src[0]), [0.5, 0, 0, 1],
        'a braced constant is the grammar\'s own form, which pads instead');
});

test('comments and blank lines are skipped, and END closes the program', ()=>{
    const program = parsed(`
        # a comment before the header is not: the header comes first
        !!ARBvp1.0
        # the whole of it
        TEMP r0;   # trailing
        MOV r0, vertex.position;
        END
        `);
    assert.equal(program.instructions.length, 1);
    const after = parseProgram('!!ARBvp1.0\nEND\nMOV r0, r0;\n');
    assert.ok('error' in after);
    const missing = parseProgram('!!ARBvp1.0\nTEMP r0;\n');
    assert.ok('error' in missing);
    assert.match(missing.error.message, /END/);
});

test('every vertex instruction parses to its shape', ()=>{
    const shapes = {
        ARL: 'ARL a0.x, r0.x;',
        ABS: 'ABS r1, r0;',
        ADD: 'ADD r1, r0, r2;',
        DP3: 'DP3 r1.x, r0, r2;',
        DP4: 'DP4 r1.x, r0, r2;',
        DPH: 'DPH r1.x, r0, r2;',
        DST: 'DST r1, r0, r2;',
        EX2: 'EX2 r1, r0.x;',
        EXP: 'EXP r1, r0.x;',
        FLR: 'FLR r1, r0;',
        FRC: 'FRC r1, r0;',
        LG2: 'LG2 r1, r0.x;',
        LIT: 'LIT r1, r0;',
        LOG: 'LOG r1, r0.x;',
        MAD: 'MAD r1, r0, r2, r3;',
        MAX: 'MAX r1, r0, r2;',
        MIN: 'MIN r1, r0, r2;',
        MOV: 'MOV r1, r0;',
        MUL: 'MUL r1, r0, r2;',
        POW: 'POW r1.x, r0.x, r2.y;',
        RCP: 'RCP r1.x, r0.w;',
        RSQ: 'RSQ r1.x, r0.x;',
        SGE: 'SGE r1, r0, r2;',
        SLT: 'SLT r1, r0, r2;',
        SUB: 'SUB r1, r0, r2;',
        SWZ: 'SWZ r1, r0, (x, -y, 1, 0);',
        XPD: 'XPD r1, r0, r2;',
    };
    const program = parsed(`!!ARBvp1.0
TEMP r0, r1, r2, r3;
ADDRESS a0;
${Object.values(shapes).join('\n')}
END
`);
    assert.equal(program.instructions.length, Object.keys(shapes).length);
    assert.deepEqual(program.instructions.map(i=>i.op), Object.keys(shapes));
    const arl = program.instructions[0];
    assert.equal(arl.dst?.kind, 'address');
    assert.equal(arl.dst?.mask, 'x');
    assert.deepEqual(arl.src[0].components, ['x', 'x', 'x', 'x']);
    const swz = program.instructions.find(i=>i.op === 'SWZ');
    assert.deepEqual(swz?.src[0].components, ['x', '-y', '1', '0']);
    assert.equal(swz?.src[0].extended, true);
    // A fragment-only instruction is refused in a vertex program, and so is
    // its _SAT form anywhere in one.
    const kil = parseProgram('!!ARBvp1.0\nKIL r0;\nEND\n');
    assert.ok('error' in kil);
    assert.match(kil.error.message, /not a vertex program instruction/);
    const sat = parseProgram('!!ARBvp1.0\nTEMP r0;\nMOV_SAT r0, r0;\nEND\n');
    assert.ok('error' in sat);
});

test('every fragment instruction parses, and _SAT lands on the instruction', ()=>{
    const ops = ['ABS', 'ADD', 'CMP', 'COS', 'DP3', 'DP4', 'DPH', 'DST', 'EX2', 'FLR', 'FRC',
        'LG2', 'LIT', 'LRP', 'MAD', 'MAX', 'MIN', 'MOV', 'MUL', 'POW', 'RCP', 'RSQ', 'SCS',
        'SIN', 'SLT', 'SGE', 'SUB', 'SWZ', 'XPD'];
    const scalars = ['RCP', 'RSQ', 'COS', 'SIN', 'SCS', 'EX2', 'LG2'];
    const binaries = ['ADD', 'DP3', 'DP4', 'DPH', 'DST', 'MAX', 'MIN', 'MUL', 'SGE', 'SLT',
        'SUB', 'XPD'];
    /** @param {string} op */
    const line = op=>{
        if (op === 'CMP' || op === 'LRP' || op === 'MAD')
        {
            return `${op}_SAT r1, r0, r2, r3;`;
        }
        if (op === 'SWZ')
        {
            return `${op}_SAT r1, r0, (x, y, z, w);`;
        }
        if (op === 'POW')
        {
            return 'POW_SAT r1.x, r0.x, r2.x;';
        }
        return `${op}_SAT r1, r0${scalars.includes(op) ? '.x' : ''}`
            + `${binaries.includes(op) ? ', r2' : ''};`;
    };
    const program = parsed(`!!ARBfp1.0
TEMP r0, r1, r2, r3;
${ops.map(line).join('\n')}
KIL r0;
TEX r1, r0, texture[2], 2D;
TXB r1, r0, texture, CUBE;
TXP r1, r0, texture[1], RECT;
END
`);
    assert.deepEqual(program.instructions.slice(0, ops.length).map(i=>i.op), ops);
    assert.ok(program.instructions.slice(0, ops.length).every(i=>i.saturate));
    assert.equal(program.instructions.find(i=>i.op === 'KIL')?.saturate, false);
    assert.equal(program.instructions.find(i=>i.op === 'KIL')?.dst, null);
    const tex = program.instructions.find(i=>i.op === 'TEX');
    assert.deepEqual(tex?.texture, { unit: 2, target: '2D' });
    assert.deepEqual(program.instructions.find(i=>i.op === 'TXB')?.texture,
        { unit: 0, target: 'CUBE' });
    assert.deepEqual(program.instructions.find(i=>i.op === 'TXP')?.texture,
        { unit: 1, target: 'RECT' });
    assert.equal(program.counts.tex, 3);
    assert.equal(program.counts.alu, program.counts.instructions - 3);
    // A vertex-only instruction is refused in a fragment program.
    const arl = parseProgram('!!ARBfp1.0\nARL a0.x, r0.x;\nEND\n');
    assert.ok('error' in arl);
});

test('swizzles normalise to four components, masks to ascending xyzw, signs to each component',
    ()=>{
        const program = parsed(`!!ARBfp1.0
TEMP r0, r1;
MOV r1, r0;
MOV r1.zw, -r0.rgba;
MUL r1, r0.bgra, -r0.x;
END
`);
        assert.deepEqual(program.instructions[0].src[0].components, ['x', 'y', 'z', 'w']);
        assert.deepEqual(program.instructions[0].dst?.mask, 'xyzw');
        assert.deepEqual(program.instructions[1].src[0].components, ['-x', '-y', '-z', '-w']);
        assert.equal(program.instructions[1].dst?.mask, 'zw');
        assert.deepEqual(program.instructions[2].src[0].components, ['z', 'y', 'x', 'w']);
        assert.deepEqual(program.instructions[2].src[1].components,
            ['-x', '-x', '-x', '-x']);
        const badMask = parseProgram('!!ARBfp1.0\nTEMP r0;\nMOV r0.zx, r0;\nEND\n');
        assert.ok('error' in badMask);
        assert.match(badMask.error.message, /write mask/);
        const badSwizzle = parseProgram('!!ARBfp1.0\nTEMP r0;\nMOV r0, r0.xy;\nEND\n');
        assert.ok('error' in badSwizzle);
        const scalarNeedsSuffix = parseProgram(
            '!!ARBfp1.0\nTEMP r0;\nRCP r0.x, r0;\nEND\n');
        assert.ok('error' in scalarNeedsSuffix);
        assert.match(scalarNeedsSuffix.error.message, /scalar source/);
    });

test('declarations establish names, and a second definition or a missing one is refused', ()=>{
    const program = parsed(`!!ARBvp1.0
TEMP a, b, r0;
ATTRIB tc = vertex.texcoord[1];
PARAM light = program.env[4];
OUTPUT col = result.color.front.secondary;
ALIAS c = a;
ADDRESS a0;
MOV col, tc;
ADD c, a, b;
MOV result.position, vertex.attrib[0];
RCP r0.x, light.x;
ARL a0.x, r0.x;
END
`);
    assert.deepEqual(program.temporaries, ['a', 'b', 'r0']);
    assert.equal(program.address, 'a0');
    assert.deepEqual(program.aliases, [{ name: 'c', target: 'a' }]);
    assert.equal(program.attribs[0].binding.attrib, 9);
    assert.deepEqual(program.outputs[0].binding,
        { kind: 'result', name: 'color', face: 'front', colour: 'secondary', index: 0 });
    const alias = program.instructions[1].dst;
    assert.equal(alias?.name, 'c');
    const twice = parseProgram('!!ARBvp1.0\nTEMP a, a;\nEND\n');
    assert.ok('error' in twice);
    assert.equal(twice.error.position, '!!ARBvp1.0\nTEMP a, '.length);
    const missing = parseProgram('!!ARBvp1.0\nMOV r0, vertex.position;\nEND\n');
    assert.ok('error' in missing);
    assert.match(missing.error.message, /'r0' is not declared/);
    assert.equal(missing.error.position, '!!ARBvp1.0\nMOV '.length);
    const reserved = parseProgram('!!ARBvp1.0\nTEMP program;\nEND\n');
    assert.ok('error' in reserved);
});

test('parameter bindings: constants pad, ranges flatten, matrices flatten to rows', ()=>{
    const program = parsed(`!!ARBvp1.0
PARAM c1 = { 1.0, -0.5 };
PARAM c2 = { 2 };
PARAM locals[8] = { program.local[0..3], state.matrix.mvp };
PARAM inv = state.matrix.modelview[1].invtrans.row[2];
PARAM proj[4] = { state.matrix.projection.row[0..3] };
MOV result.position, c1;
END
`);
    assert.deepEqual(program.params[0].slots, [{ kind: 'constant', values: [1, -0.5, 0, 1] }]);
    assert.deepEqual(program.params[1].slots, [{ kind: 'constant', values: [2, 0, 0, 1] }]);
    const locals = program.params[2];
    assert.equal(locals.array, true);
    assert.equal(locals.slots.length, 8);
    assert.deepEqual(locals.slots[0], { kind: 'local', index: 0 });
    assert.deepEqual(locals.slots[3], { kind: 'local', index: 3 });
    assert.deepEqual(locals.slots[4],
        { kind: 'state', state: 'matrix', matrix: 'mvp', number: 0, modifier: '', row: 0 });
    assert.deepEqual(locals.slots[7],
        { kind: 'state', state: 'matrix', matrix: 'mvp', number: 0, modifier: '', row: 3 });
    assert.deepEqual(program.params[3].slots, [{ kind: 'state', state: 'matrix',
        matrix: 'modelview', number: 1, modifier: 'invtrans', row: 2 }]);
    assert.equal(program.params[4].array, true);
    assert.equal(program.params[4].slots.length, 4);
    assert.equal(program.counts.parameters, 1 + 1 + 8 + 1 + 4);
    // A declared size the list does not fill is refused, and a whole matrix
    // is refused outside an array.
    const sizeMismatch = parseProgram(
        '!!ARBvp1.0\nPARAM p[4] = { program.local[0..1] };\nEND\n');
    assert.ok('error' in sizeMismatch);
    assert.match(sizeMismatch.error.message, /declares 4 parameters and the list binds 2/);
    const wholeSingle = parseProgram(
        '!!ARBvp1.0\nPARAM p = state.matrix.mvp;\nEND\n');
    assert.ok('error' in wholeSingle);
    assert.match(wholeSingle.error.message, /whole matrix/);
    const rangeSingle = parseProgram(
        '!!ARBvp1.0\nPARAM p = program.local[0..3];\nEND\n');
    assert.ok('error' in rangeSingle);
});

test('state bindings outside the matrices parse and arrive marked unsupported', ()=>{
    const program = parsed(`!!ARBvp1.0
PARAM mat = state.material.ambient;
PARAM matBack = state.material.back.shininess;
PARAM light = state.light[2].spot.direction;
PARAM model = state.lightmodel.front.scenecolor;
PARAM prod = state.lightprod[1].back.specular;
PARAM gen = state.texgen[1].eye.s;
PARAM fogc = state.fog.color;
PARAM clip = state.clip[0].plane;
PARAM point = state.point.size;
PARAM palette = state.matrix.palette[3];
PARAM prog = state.matrix.program[0].row[1];
MOV result.position, mat;
END
`);
    const slots = program.params.map(decl=>decl.slots[0]);
    assert.deepEqual(slots.map(s=>(s.kind === 'state' && 'state' in s ? s.state : '?')),
        ['material', 'material', 'light', 'lightmodel', 'lightprod', 'texgen', 'fog', 'clip',
            'point', 'palette', 'program-matrix']);
    assert.match(slots[0].kind === 'state' && 'text' in slots[0] ? slots[0].text : '',
        /^state\.material\.ambient$/);
    assert.match(slots[10].kind === 'state' && 'text' in slots[10] ? slots[10].text : '',
        /^state\.matrix\.program\[0\]\.row\[1\]$/);
    const fragmentState = parsed(`!!ARBfp1.0
PARAM env = state.texenv[0].color;
PARAM range = state.depth.range;
MOV result.color, env;
END
`);
    assert.equal(fragmentState.params[0].slots[0].kind, 'state');
    assert.equal(fragmentState.params[1].slots[0].kind, 'state');
});

test('relative addressing parses for a vertex parameter array only', ()=>{
    const program = parsed(`!!ARBvp1.0
TEMP r0;
ADDRESS a0;
PARAM bones[4] = { program.local[0..3] };
ARL a0.x, r0.x;
MOV r0, bones[a0.x + 2];
MOV r0, bones[a0.x - 1];
MOV r0, bones[3];
END
`);
    const [relative, negative, absolute] = program.instructions.slice(1);
    assert.equal(relative.src[0].name, 'bones');
    assert.equal(relative.src[0].relative, 2);
    assert.equal(negative.src[0].relative, -1);
    assert.equal(absolute.src[0].index, 3);
    const fragment = parseProgram(`!!ARBfp1.0
TEMP r0;
PARAM p[4] = { program.local[0..3] };
MOV r0, p[1];
END
`);
    assert.ok(!('error' in fragment));
    const outOfRange = parseProgram(`!!ARBvp1.0
TEMP r0;
PARAM p[4] = { program.local[0..3] };
MOV r0, p[7];
END
`);
    assert.ok('error' in outOfRange);
    assert.match(outOfRange.error.message, /holds 4 parameters/);
    const noIndex = parseProgram(`!!ARBvp1.0
TEMP r0;
PARAM p[4] = { program.local[0..3] };
MOV r0, p;
END
`);
    assert.ok('error' in noIndex);
});

test('attribute bindings alias to the generic numbers, and a double binding is refused', ()=>{
    const program = parsed(`!!ARBvp1.0
ATTRIB pos = vertex.position;
ATTRIB nrm = vertex.normal;
ATTRIB col = vertex.color.primary;
ATTRIB sec = vertex.color.secondary;
ATTRIB fog = vertex.fogcoord;
ATTRIB tc3 = vertex.texcoord[3];
ATTRIB gen = vertex.attrib[15];
MOV result.position, pos;
END
`);
    assert.deepEqual(program.attribs.map(a=>a.binding.attrib), [0, 2, 3, 4, 5, 11, 15]);
    assert.equal(program.counts.attribs, 7);
    const pair = parseProgram('!!ARBvp1.0\nATTRIB p = vertex.position;\n'
        + 'MOV result.position, vertex.attrib[0];\nEND\n');
    assert.ok('error' in pair);
    assert.match(pair.error.message, /conventionally/);
    const weight = parsed('!!ARBvp1.0\nMOV result.position, vertex.weight[4];\nEND\n');
    const binding = weight.instructions[0].src[0].binding;
    assert.ok(binding && binding.kind === 'vertex' && binding.attrib === null,
        'an extra weight has no generic attribute');
});

test('options: position invariance forbids the position write, fog options are exclusive', ()=>{
    const invariant = parseProgram(`!!ARBvp1.0
OPTION ARB_position_invariant;
TEMP r0;
MOV result.position, r0;
END
`);
    assert.ok('error' in invariant);
    assert.match(invariant.error.message, /position-invariant/);
    const allowed = parsed(`!!ARBvp1.0
OPTION ARB_position_invariant;
TEMP r0;
MOV r0, vertex.position;
END
`);
    assert.equal(allowed.positionInvariant, true);
    const badOption = parseProgram('!!ARBvp1.0\nOPTION ARB_fog_exp;\nEND\n');
    assert.ok('error' in badOption);
    const fogged = parsed(`!!ARBfp1.0
OPTION ARB_precision_hint_fastest;
OPTION ARB_fog_exp2;
MOV result.color, fragment.color;
END
`);
    assert.equal(fogged.precisionHint, 'fastest');
    assert.equal(fogged.fog, 'exp2');
    const twice = parseProgram(`!!ARBfp1.0
OPTION ARB_fog_exp;
OPTION ARB_fog_linear;
END
`);
    assert.ok('error' in twice);
    const late = parseProgram('!!ARBfp1.0\nMOV result.color, fragment.color;\n'
        + 'OPTION ARB_fog_exp;\nEND\n');
    assert.ok('error' in late);
});

test('error positions are the byte offset of the first bad character', ()=>{
    const text = '!!ARBfp1.0\nTEMP r0;\nMOV r0, r0 @ r1;\nEND\n';
    const bad = parseProgram(text);
    assert.ok('error' in bad);
    assert.equal(bad.error.position, text.indexOf('@'));
    const unknown = parseProgram('!!ARBfp1.0\nFROB r0, r0;\nEND\n');
    assert.ok('error' in unknown);
    assert.equal(unknown.error.position, '!!ARBfp1.0\n'.length);
    const noSemicolon = parseProgram('!!ARBfp1.0\nTEMP r0\nEND\n');
    assert.ok('error' in noSemicolon);
    assert.equal(noSemicolon.error.position, '!!ARBfp1.0\nTEMP r0\n'.length,
        'the missing semicolon is reported at what follows it');
});

test('a program past a reported limit is refused at the end of its text', ()=>{
    const body = Array.from({ length: PROGRAM_LIMITS.vertex.instructions + 1 },
        (unused, i)=>`MOV result.texcoord[${i % 8}], vertex.position;`).join('\n');
    const text = `!!ARBvp1.0\n${body}\nEND\n`;
    const over = parseProgram(text);
    assert.ok('error' in over);
    assert.equal(over.error.position, text.length);
    const temps = parseProgram(`!!ARBfp1.0\nTEMP ${
        Array.from({ length: PROGRAM_LIMITS.fragment.temporaries + 1 },
            (unused, i)=>`t${i}`).join(', ')};\nEND\n`);
    assert.ok('error' in temps);
    const fits = parseProgram(`!!ARBfp1.0\nTEMP ${
        Array.from({ length: PROGRAM_LIMITS.fragment.temporaries },
            (unused, i)=>`t${i}`).join(', ')};\nEND\n`);
    assert.ok(!('error' in fits));
});

test('a realistic pair of programs round-trips through the IR', ()=>{
    const vertexText = `!!ARBvp1.0
# transform, and pass the light vectors through to the fragment stage
TEMP diffuse, position, eye;
ATTRIB inPos = vertex.position;
ATTRIB inNormal = vertex.normal;
ATTRIB inTex = vertex.texcoord[0];
PARAM mvp[4] = { state.matrix.mvp };
PARAM modelview[4] = { state.matrix.modelview[0] };
PARAM lightPos = program.env[10];
PARAM halfAngle = program.local[0];
OUTPUT outTex = result.texcoord[0];
OUTPUT outColour = result.color;
DP4 position.x, inPos, mvp[0];
DP4 position.y, inPos, mvp[1];
DP4 position.z, inPos, mvp[2];
DP4 position.w, inPos, mvp[3];
DP4 eye.x, inPos, modelview[0];
DP4 eye.y, inPos, modelview[1];
DP4 eye.z, inPos, modelview[2];
SUB eye, lightPos, eye;
DP3 diffuse.x, inNormal, eye;
DP3 diffuse.y, inNormal, halfAngle;
MOV diffuse.z, inPos.w;
MOV diffuse.w, inPos.w;
MUL outColour, diffuse, vertex.color.primary;
MOV outTex, inTex;
MOV result.position, position;
END
`;
    const vertexProgram = parseProgram(vertexText);
    assert.ok(!('error' in vertexProgram),
        'error' in vertexProgram ? vertexProgram.error.message : '');
    assert.equal(vertexProgram.counts.instructions, 15);
    assert.equal(vertexProgram.counts.parameters, 10);
    const outColour = vertexProgram.instructions.find(i=>i.dst?.name === 'outColour');
    assert.equal(outColour?.op, 'MUL');
    assert.deepEqual(outColour?.dst?.binding,
        { kind: 'result', name: 'color', face: null, colour: null, index: 0 });
    const mvpRow = vertexProgram.params[0].slots[0];
    assert.deepEqual(mvpRow,
        { kind: 'state', state: 'matrix', matrix: 'mvp', number: 0, modifier: '', row: 0 });

    const fragmentText = `!!ARBfp1.0
OPTION ARB_precision_hint_fastest;
OPTION ARB_fog_exp;
TEMP light, bump, base, spec, final;
PARAM one = { 1.0 };
PARAM shininess = { 32.0, 0.5, 0.25, 1.0 };
TEX bump, fragment.texcoord[0], texture[0], 2D;
TEX base, fragment.texcoord[0], texture[1], 2D;
TXP spec, fragment.texcoord[1], texture[2], CUBE;
MAD bump, bump, { 2.0, 2.0, 2.0, 0.0 }, { -1.0, -1.0, -1.0, 0.0 };
DP3 light.x, bump, fragment.color;
KIL light.x;
CMP_SAT light.y, light.x, one, { 0.2, 0.2, 0.2, 1.0 };
POW spec.x, light.x, shininess.x;
MUL final, base, light.y;
MAD_SAT final, spec.x, shininess.z, final;
SWZ light.zw, spec, (x, 0, 1, -y);
MOV result.color, final;
MOV result.depth, fragment.position.z;
END
`;
    const fragmentProgram = parseProgram(fragmentText);
    assert.ok(!('error' in fragmentProgram),
        'error' in fragmentProgram ? fragmentProgram.error.message : '');
    assert.equal(fragmentProgram.fog, 'exp');
    assert.equal(fragmentProgram.counts.tex, 3);
    assert.equal(fragmentProgram.counts.instructions, 13);
    const kill = fragmentProgram.instructions.find(i=>i.op === 'KIL');
    assert.deepEqual(kill?.src[0].components, ['x', 'x', 'x', 'x']);
    const mad = fragmentProgram.instructions.find(i=>i.op === 'MAD' && !i.saturate);
    assert.equal(mad?.src[1].binding?.kind, 'constant');
    const cmp = fragmentProgram.instructions.find(i=>i.op === 'CMP');
    assert.equal(cmp?.saturate, true);
    const swz = fragmentProgram.instructions.find(i=>i.op === 'SWZ');
    assert.deepEqual(swz?.src[0].components, ['x', '0', '1', '-y']);
    assert.deepEqual(swz?.dst?.mask, 'zw');
    const depth = fragmentProgram.instructions.find(i=>i.dst?.binding?.kind === 'result'
        && i.dst.binding.name === 'depth');
    assert.equal(depth?.op, 'MOV');
    assert.deepEqual(depth?.src[0].binding,
        { kind: 'fragment', name: 'position', index: 0 });
});
