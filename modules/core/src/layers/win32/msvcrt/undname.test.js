/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { undecorateName, undecorateType } from './undname.js';

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

/**
 * Decorated names and what Windows' msvcrt writes for them, the flags
 * beside each: functions, members, thunks, tables, RTTI, templates, nested
 * symbols and their back references, and the 64-bit modifiers.
 *
 * @type {[string, number, string][]}
 */
const SYMBOLS = [
    ['??0bad_alloc@std@@QAE@ABV01@@Z', 0,
        'public: __thiscall std::bad_alloc::bad_alloc(class std::bad_alloc const &)'],
    ['??0bad_cast@@AAE@PBQBD@Z', 0,
        'private: __thiscall bad_cast::bad_cast(char const * const *)'],
    ['??0strstreambuf@@QAE@Q6APAXJ@ZS6AXPAX@Z@Z', 0,
        'public: __thiscall strstreambuf::strstreambuf(void * (__cdecl*const)(long),void (__c'
            + 'decl*const volatile)(void *))'],
    ['??6?$basic_ostream@GU?$char_traits@G@std@@@std@@QAEAAV01@P6AAAVios_base@1@AAV21@@Z@Z', 0,
        'public: class std::basic_ostream<unsigned short,struct std::char_traits<unsigned sho'
            + 'rt> > & __thiscall std::basic_ostream<unsigned short,struct std::char_traits<unsigne'
            + 'd short> >::operator<<(class std::ios_base & (__cdecl*)(class std::ios_base &))'],
    ['?_query_new_handler@@YAR6AHI@ZXZ', 0,
        'int (__cdecl*__cdecl _query_new_handler(void))(unsigned int)'],
    ['?set_new_handler@@YAP6AXXZP6AXXZ@Z', 0,
        'void (__cdecl*__cdecl set_new_handler(void (__cdecl*)(void)))(void)'],
    ['?pSW@@3P6GHKPAX0PAU_tagSTACKFRAME@@0P6GH0K0KPAK@ZP6GPAX0K@ZP6GK0K@ZP6GK00PAU_tagADDRESS@'
        + '@@Z@ZA', 0,
    'int (__stdcall* pSW)(unsigned long,void *,void *,struct _tagSTACKFRAME *,void *,int '
            + '(__stdcall*)(void *,unsigned long,void *,unsigned long,unsigned long *),void * (__st'
            + 'dcall*)(void *,unsigned long),unsigned long (__stdcall*)(void *,unsigned long),unsig'
            + 'ned long (__stdcall*)(void *,void *,struct _tagADDRESS *))'],
    ['??0?$Foo@P6GHPAX0@Z@@QAE@PAD@Z', 0x880,
        '__thiscall Foo<int (__stdcall*)(void *,void *)>::Foo<int (__stdcall*)(void *,void *)'
            + '>(char *)'],
    ['?Qux@Bar@@0PAP6AHPAV1@AAH1PAH@ZA', 0,
        'private: static int (__cdecl** Bar::Qux)(class Bar *,int &,int &,int *)'],
    ['?Qux@Bar@@0PAP6AHPAV1@AAH1PAH@ZA', 0x1800,
        'Bar::Qux'],
    ['??$ccccc@PAVaaa@@@bar@bb@foo@@DGPAV0@PAV0@PAVee@@IPAPAVaaa@@1@Z', 0,
        'private: static class bar * __stdcall foo::bb::bar::ccccc<class aaa *>(class bar *,c'
            + 'lass ee *,unsigned int,class aaa * *,class ee *)'],
    ['??Xstd@@YAAEAV?$complex@M@0@AEAV10@AEBV10@@Z', 0,
        'class std::complex<float> & __ptr64 __cdecl std::operator*=(class std::complex<float'
            + '> & __ptr64,class std::complex<float> const & __ptr64)'],
    ['??$?DM@std@@YA?AV?$complex@M@0@ABMABV10@@Z', 0,
        'class std::complex<float> __cdecl std::operator*<float>(float const &,class std::com'
            + 'plex<float> const &)'],
    ['?_R2@?BN@???$_Fabs@N@std@@YANAEBV?$complex@N@1@PEAH@Z@4NB', 0,
        'double const `double __cdecl std::_Fabs<double>(class std::complex<double> const & _'
            + '_ptr64,int * __ptr64)\'::`29\'::_R2'],
    ['?_Doraise@bad_cast@std@@MEBAXXZ', 0x60,
        'protected: virtual void __cdecl std::bad_cast::_Doraise(void)'],
    ['??Xstd@@YAAEAV?$complex@M@0@AEAV10@AEBV10@@Z', 1,
        'class std::complex<float> & ptr64 cdecl std::operator*=(class std::complex<float> & '
            + 'ptr64,class std::complex<float> const & ptr64)'],
    ['??Xstd@@YAAEAV?$complex@M@0@AEAV10@AEBV10@@Z', 2,
        'class std::complex<float> & std::operator*=(class std::complex<float> &,class std::c'
            + 'omplex<float> const &)'],
    ['??$run@XVTask_Render_Preview@@@QtConcurrent@@YA?AV?$QFuture@X@@PEAVTask_Render_Preview@@'
        + 'P82@EAAXXZ@Z', 0,
    'class QFuture<void> __cdecl QtConcurrent::run<void,class Task_Render_Preview>(class '
            + 'Task_Render_Preview * __ptr64,void (__cdecl Task_Render_Preview::*)(void) __ptr64)'],
    ['?func@@YAXPIFAH@Z', 0,
        'void __cdecl func(int __unaligned * __restrict)'],
    ['?Qux@Bar@@0PAPAP6AHPAV1@AAH1PAH@ZA', 0,
        'private: static int (__cdecl** * Bar::Qux)(class Bar *,int &,int &,int *)'],
    ['?pfunc@@3PAY0E@P6AXF@ZA', 0,
        'void (__cdecl*(* pfunc)[4])(short)'],
    ['??$?0AEAVzzz@BB4@AA@@AEAV012@$0A@@?$pair@Vzzz@BB4@AA@@V123@@std@@QEAA@AEAVzzz@BB4@AA@@0@Z', 0,
        'public: __cdecl std::pair<class AA::BB4::zzz,class AA::BB4::zzz>::pair<class AA::BB4'
            + '::zzz,class AA::BB4::zzz><class AA::BB4::zzz & __ptr64,class AA::BB4::zzz & __ptr64,'
            + '0>(class AA::BB4::zzz & __ptr64,class AA::BB4::zzz & __ptr64) __ptr64'],
    ['??$?BH@?$foo@N@@QEAAHXZ', 0,
        'public: __cdecl foo<double>::operator<int> int(void) __ptr64'],
    ['?ptititi1@@3PEQtititi@@IEQ1@', 0,
        'unsigned int tititi::* __ptr64 __ptr64 ptititi1'],
    ['?ptititi4v@@3RETtititi@@IET1@', 0,
        'unsigned int const volatile tititi::* __ptr64 const volatile __ptr64 ptititi4v'],
    ['?RegisterModuleUninitializer@<CrtImplementationDetails>@@YAXBE$AAVEventHandler@System@@@Z', 0,
        'void __cdecl <CrtImplementationDetails>::RegisterModuleUninitializer(class System::E'
            + 'ventHandler % __ptr64 volatile)'],
    ['??$forward@AEAUFFIValue@?1??call@FFIFunctionBinder@@CAHPEAUlua_State@@@Z@@std@@YAAEAUFFI'
        + 'Value@?1??call@FFIFunctionBinder@@CAHPEAUxlua_State@@@Z@AEAU1?1??23@CAH0@Z@@Z', 0,
    'struct `private: static int __cdecl FFIFunctionBinder::call(struct xlua_State * __pt'
            + 'r64)\'::`2\'::FFIValue & __ptr64 __cdecl std::forward<struct `private: static int __'
            + 'cdecl FFIFunctionBinder::call(struct lua_State * __ptr64)\'::`2\'::FFIValue & __ptr6'
            + '4>(struct `private: static int __cdecl FFIFunctionBinder::call(struct xlua_State * _'
            + '_ptr64)\'::`2\'::FFIValue & __ptr64)'],
];

test('a symbol undecorates as the runtime writes it', ()=>{
    for (const [mangled, flags, expected] of SYMBOLS)
    {
        assert.equal(undecorateName(mangled, flags), expected, mangled);
    }
});

test('the type-only flag reads a type, and what cannot be read comes back as it is', ()=>{
    assert.equal(undecorateName('P8test@@AACXZ', 0x2800), 'signed char (__cdecl test::*)(void)');
    assert.equal(undecorateName('P8test@@BACXZ', 0x2800),
        'signed char (__cdecl test::*)(void)const ');
    assert.equal(undecorateName('?AV?$CDB@W4BITS@@$01@@@', 0x2800), '?AV?$CDB@W4BITS@@$01@@@');
    assert.equal(undecorateName('?nothing'), '?nothing');
    assert.equal(undecorateName('??0bad_alloc@std@@QAE@ABV01@'), '??0bad_alloc@std@@QAE@ABV01@');
});
