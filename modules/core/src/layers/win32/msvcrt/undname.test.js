/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { undecorateType } from './undname.js';

test('a type descriptor\'s name undecorates as type_info::name() gives it', ()=>{
    assert.equal(undecorateType('?AVtest1@@'), 'class test1');
    assert.equal(undecorateType('?AUpoint@@'), 'struct point');
    assert.equal(undecorateType('?AVbad_alloc@std@@'), 'class std::bad_alloc');
    assert.equal(undecorateType('?AW4color@@'), 'enum color');
    assert.equal(undecorateType('?AH'), 'int');
});

test('qualifiers, references and pointers read as the C++ they stand for', ()=>{
    // msvcrt's cpp test, demangle_datatype.
    assert.equal(undecorateType('ABVVec4@ref2@dice@@'), 'class dice::ref2::Vec4 const &');
    assert.equal(undecorateType('PAH'), 'int *');
    assert.equal(undecorateType('PBD'), 'char const *');
    assert.equal(undecorateType('QAH'), 'int * const');
    assert.equal(undecorateType('PA_W'), 'wchar_t *');
});

test('templates take types and numbers, and a digit names a part read before', ()=>{
    for (const [code, value] of [['H', 7], ['HO', 126], ['HOA', 2016], ['HOAA', 32256]])
    {
        assert.equal(undecorateType(
            `?AV?$CDB_GEN_BIG_ENUM_FLAG@W4CDB_WYSIWYG_BITS_ENUM@@$0${code}@@@`),
        `class CDB_GEN_BIG_ENUM_FLAG<enum CDB_WYSIWYG_BITS_ENUM,${value}>`);
    }
    // typeid(std::string).name(): `2` is std, read inside the template.
    assert.equal(undecorateType(
        '?AV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@'),
    'class std::basic_string<char,struct std::char_traits<char>,class std::allocator<char> >');
});

test('what is not a type, or is cut short, undecorates to nothing', ()=>{
    assert.equal(undecorateType('??0bad_alloc@std@@QAE@ABV01@@Z'), null);
    assert.equal(undecorateType('?AVtest1@'), null);
    assert.equal(undecorateType('?AVtest1@@extra'), null);
    assert.equal(undecorateType('BlaBla'), null);
    assert.equal(undecorateType(''), null);
});
