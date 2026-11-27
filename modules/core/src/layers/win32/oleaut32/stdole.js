/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * stdole2.tlb, the OLE Automation library every Windows has in its system
 * directory: the structures and interfaces automation itself is made of
 * (GUID, DISPPARAMS, EXCEPINFO, IUnknown, IDispatch, IEnumVARIANT), the
 * OLE_ typedefs controls describe their properties with, IFont and IPicture
 * with their dispinterfaces and coclasses, and the StdFunctions module.
 *
 * A program loads it by name -- LoadTypeLib("stdole2.tlb") -- and imports
 * from it in its own libraries, so it has to be there whether or not a file
 * is. The contents are the platform's published contract: the names, GUIDs,
 * DISPIDs (olectl.h's DISPID_FONT_* and DISPID_PICT_*) and signatures of
 * stdole2's IDL, laid out in the order a compiler writes it.
 */

import {
    TKIND_DISPATCH, TKIND_ENUM, TKIND_INTERFACE, TKIND_MODULE, TKIND_RECORD,
} from './typelib.js';

/** @typedef {import('./typelib.js').TypeDescription} TypeDescription */
/** @typedef {import('./typelib.js').TypeInfoDescription} TypeInfoDescription */
/** @typedef {import('./typelib.js').FunctionDescription} FunctionDescription */
/** @typedef {import('./typelib.js').TypeLibrary} TypeLibrary */

export const STDOLE_GUID = '{00020430-0000-0000-C000-000000000046}';

const TKIND_COCLASS = 5;
const TKIND_ALIAS = 6;

const VT_I2 = 2;
const VT_I4 = 3;
const VT_R4 = 4;
const VT_CY = 6;
const VT_BSTR = 8;
const VT_ERROR = 10;
const VT_BOOL = 11;
const VT_VARIANT = 12;
const VT_I1 = 16;
const VT_UI1 = 17;
const VT_UI2 = 18;
const VT_UI4 = 19;
const VT_INT = 22;
const VT_UINT = 23;
const VT_VOID = 24;
const VT_HRESULT = 25;
const VT_PTR = 26;
const VT_CARRAY = 28;
const VT_USERDEFINED = 29;

const TYPEFLAG_FCANCREATE = 0x2;
const TYPEFLAG_FHIDDEN = 0x10;
const TYPEFLAG_FRESTRICTED = 0x200;
const TYPEFLAG_FDISPATCHABLE = 0x1000;
const FUNCFLAG_FRESTRICTED = 0x1;
const VARFLAG_FREADONLY = 0x1;
const IMPLTYPEFLAG_FDEFAULT = 0x1;

const FUNC_PUREVIRTUAL = 1;
const FUNC_STATIC = 3;
const FUNC_DISPATCH = 4;
const INVOKE_FUNC = 1;
const INVOKE_PROPERTYGET = 2;
const INVOKE_PROPERTYPUT = 4;
const CC_STDCALL = 4;
const VAR_PERINSTANCE = 0;
const VAR_CONST = 2;
const VAR_DISPATCH = 3;

const PARAMFLAG_FIN = 0x1;
const PARAMFLAG_FOUT = 0x2;
const PARAMFLAG_FRETVAL = 0x8;
const PARAMFLAG_FOPT = 0x10;
const PARAMFLAG_FHASDEFAULT = 0x20;

/** How a type of this library is referred to: its index in hundreds, as in MSFT. */
const TYPEINFO_BYTES = 0x64;

/** @param {number} vt @returns {TypeDescription} */
const plain = vt=>({ vt, element: null, hreftype: -1, array: null });
/** @param {TypeDescription} element @returns {TypeDescription} */
const pointer = element=>({ vt: VT_PTR, element, hreftype: -1, array: null });

/** The index of each type by name, filled in the order the types are listed. */
const NAMES = ['GUID', 'DISPPARAMS', 'EXCEPINFO', 'IUnknown', 'IDispatch', 'IEnumVARIANT',
    'OLE_COLOR', 'OLE_XPOS_PIXELS', 'OLE_YPOS_PIXELS', 'OLE_XSIZE_PIXELS', 'OLE_YSIZE_PIXELS',
    'OLE_XPOS_HIMETRIC', 'OLE_YPOS_HIMETRIC', 'OLE_XSIZE_HIMETRIC', 'OLE_YSIZE_HIMETRIC',
    'OLE_XPOS_CONTAINER', 'OLE_YPOS_CONTAINER', 'OLE_XSIZE_CONTAINER', 'OLE_YSIZE_CONTAINER',
    'OLE_HANDLE', 'OLE_OPTEXCLUSIVE', 'OLE_CANCELBOOL', 'OLE_ENABLEDEFAULTBOOL', 'OLE_TRISTATE',
    'FONTNAME', 'FONTSIZE', 'FONTBOLD', 'FONTITALIC', 'FONTUNDERSCORE', 'FONTSTRIKETHROUGH',
    'IFont', 'Font', 'IFontDisp', 'StdFont', 'IPicture', 'Picture', 'IPictureDisp', 'StdPicture',
    'LoadPictureConstants', 'StdFunctions', 'FontEvents', 'IFontEventsDisp'];

/** @param {string} name */
const hrefOf = name=>{
    const index = NAMES.indexOf(name);
    if (index < 0)
    {
        throw new Error(`stdole2 has no type ${name}`);
    }
    return index * TYPEINFO_BYTES;
};

/** @param {string} name @returns {TypeDescription} */
const named = name=>({ vt: VT_USERDEFINED, element: null, hreftype: hrefOf(name), array: null });

/**
 * @param {string} name @param {number} kind
 * @param {Partial<TypeInfoDescription>} fields
 * @returns {TypeInfoDescription}
 */
const type = (name, kind, fields)=>({
    index: NAMES.indexOf(name),
    hreftype: hrefOf(name),
    name,
    kind,
    guid: null,
    flags: 0,
    majorVersion: 0,
    minorVersion: 0,
    helpString: null,
    instanceSize: 4,
    alignment: 4,
    vtableSize: 0,
    functions: [],
    variables: [],
    implementedTypes: [],
    alias: null,
    ...fields,
});

/**
 * One function. `slot` is its vtable slot, or -1 for a dispatch or module
 * function.
 *
 * @param {string} name @param {number} memberId @param {number} slot
 * @param {Partial<FunctionDescription>} fields
 * @param {[string, TypeDescription, number][]} parameters  name, type, PARAMFLAG bits
 * @returns {FunctionDescription}
 */
const fn = (name, memberId, slot, fields, parameters)=>({
    memberId,
    name,
    funcKind: FUNC_PUREVIRTUAL,
    invokeKind: INVOKE_FUNC,
    callingConvention: CC_STDCALL,
    vtableOffset: Math.max(slot, 0) * 4,
    flags: 0,
    returns: plain(VT_HRESULT),
    parameters: parameters.map(([parameter, typeOf, flags])=>({ name: parameter, type: typeOf,
        flags })),
    optionalParameters: 0,
    helpString: null,
    ...fields,
});

const IN = PARAMFLAG_FIN;
const OUT = PARAMFLAG_FOUT;
const RETVAL = PARAMFLAG_FOUT | PARAMFLAG_FRETVAL;

/**
 * An interface deriving from IUnknown (level 1) or IDispatch (level 2):
 * each method numbered on from the base's, a property's get and put
 * sharing one member id, as a compiler numbers them.
 *
 * @param {number} level
 * @param {[string, number, TypeDescription, [string, TypeDescription, number][]][]} list
 *     name, INVOKE_* kind, return type, parameters
 * @param {number} firstSlot
 */
const methods = (level, list, firstSlot)=>{
    /** @type {Map<string, number>} */
    const ids = new Map();
    return list.map(([name, invokeKind, returns, parameters], index)=>{
        if (!ids.has(name))
        {
            ids.set(name, 0x60000000 + (level - 1) * 0x10000 + ids.size);
        }
        return fn(name, /** @type {number} */ (ids.get(name)), firstSlot + index,
            { invokeKind, returns }, parameters);
    });
};

/**
 * A record's fields, laid out in order at their natural alignment.
 *
 * @param {[string, TypeDescription, number][]} list  name, type, size in bytes
 */
const fields = list=>{
    let offset = 0;
    return list.map(([name, typeOf, size], index)=>{
        const align = Math.min(size, 4);
        offset = Math.ceil(offset / align) * align;
        const variable = { memberId: 0x40000000 + index, name, varKind: VAR_PERINSTANCE,
            type: typeOf, flags: 0, offset, constant: null };
        offset += size;
        return variable;
    });
};

/** @param {[string, number][]} values */
const constants = values=>values.map(([name, value], index)=>({ memberId: 0x40000000 + index,
    name, varKind: VAR_CONST, type: plain(VT_I4), flags: 0, offset: 0,
    constant: { vt: VT_I4, value } }));

/**
 * A dispinterface's properties.
 *
 * @param {[string, number, TypeDescription, boolean][]} list  name, DISPID, type, read-only
 */
const properties = list=>list.map(([name, memberId, typeOf, readOnly])=>({
    memberId, name, varKind: VAR_DISPATCH, type: typeOf, flags: readOnly ? VARFLAG_FREADONLY : 0,
    offset: 0, constant: null }));

/** @param {string} name @param {string} guid @param {TypeDescription} aliased */
const alias = (name, guid, aliased)=>type(name, TKIND_ALIAS, { guid, alias: aliased,
    instanceSize: aliased.vt === VT_BSTR || aliased.vt === VT_USERDEFINED ? 4
        : aliased.vt === VT_CY ? 8 : aliased.vt === VT_I2 || aliased.vt === VT_BOOL ? 2 : 4,
    alignment: aliased.vt === VT_CY ? 8 : aliased.vt === VT_BOOL ? 2 : 4 });

const DISPATCH_VTABLE = 7 * 4;
const UNKNOWN = named('IUnknown');
const DISPATCH = named('IDispatch');

const IFONT_METHODS = methods(2, [
    ['Name', INVOKE_PROPERTYGET, plain(VT_HRESULT), [['pname', pointer(plain(VT_BSTR)), RETVAL]]],
    ['Name', INVOKE_PROPERTYPUT, plain(VT_HRESULT), [['pname', plain(VT_BSTR), IN]]],
    ['Size', INVOKE_PROPERTYGET, plain(VT_HRESULT), [['psize', pointer(plain(VT_CY)), RETVAL]]],
    ['Size', INVOKE_PROPERTYPUT, plain(VT_HRESULT), [['psize', plain(VT_CY), IN]]],
    ['Bold', INVOKE_PROPERTYGET, plain(VT_HRESULT), [['pbold', pointer(plain(VT_BOOL)), RETVAL]]],
    ['Bold', INVOKE_PROPERTYPUT, plain(VT_HRESULT), [['pbold', plain(VT_BOOL), IN]]],
    ['Italic', INVOKE_PROPERTYGET, plain(VT_HRESULT),
        [['pitalic', pointer(plain(VT_BOOL)), RETVAL]]],
    ['Italic', INVOKE_PROPERTYPUT, plain(VT_HRESULT), [['pitalic', plain(VT_BOOL), IN]]],
    ['Underline', INVOKE_PROPERTYGET, plain(VT_HRESULT),
        [['punderline', pointer(plain(VT_BOOL)), RETVAL]]],
    ['Underline', INVOKE_PROPERTYPUT, plain(VT_HRESULT), [['punderline', plain(VT_BOOL), IN]]],
    ['Strikethrough', INVOKE_PROPERTYGET, plain(VT_HRESULT),
        [['pstrikethrough', pointer(plain(VT_BOOL)), RETVAL]]],
    ['Strikethrough', INVOKE_PROPERTYPUT, plain(VT_HRESULT),
        [['pstrikethrough', plain(VT_BOOL), IN]]],
    ['Weight', INVOKE_PROPERTYGET, plain(VT_HRESULT), [['pweight', pointer(plain(VT_I2)), RETVAL]]],
    ['Weight', INVOKE_PROPERTYPUT, plain(VT_HRESULT), [['pweight', plain(VT_I2), IN]]],
    ['Charset', INVOKE_PROPERTYGET, plain(VT_HRESULT),
        [['pcharset', pointer(plain(VT_I2)), RETVAL]]],
    ['Charset', INVOKE_PROPERTYPUT, plain(VT_HRESULT), [['pcharset', plain(VT_I2), IN]]],
    ['hFont', INVOKE_PROPERTYGET, plain(VT_HRESULT),
        [['phfont', pointer(named('OLE_HANDLE')), RETVAL]]],
    ['Clone', INVOKE_FUNC, plain(VT_HRESULT), [['ppfont', pointer(pointer(named('IFont'))), OUT]]],
    ['IsEqual', INVOKE_FUNC, plain(VT_HRESULT), [['pfontOther', pointer(named('IFont')), IN]]],
    ['SetRatio', INVOKE_FUNC, plain(VT_HRESULT),
        [['cyLogical', plain(VT_I4), IN], ['cyHimetric', plain(VT_I4), IN]]],
    ['AddRefHfont', INVOKE_FUNC, plain(VT_HRESULT), [['hFont', named('OLE_HANDLE'), IN]]],
    ['ReleaseHfont', INVOKE_FUNC, plain(VT_HRESULT), [['hFont', named('OLE_HANDLE'), IN]]],
], 3);

const IPICTURE_METHODS = methods(2, [
    ['Handle', INVOKE_PROPERTYGET, plain(VT_HRESULT),
        [['phandle', pointer(named('OLE_HANDLE')), RETVAL]]],
    ['hPal', INVOKE_PROPERTYGET, plain(VT_HRESULT),
        [['phpal', pointer(named('OLE_HANDLE')), RETVAL]]],
    ['Type', INVOKE_PROPERTYGET, plain(VT_HRESULT), [['ptype', pointer(plain(VT_I2)), RETVAL]]],
    ['Width', INVOKE_PROPERTYGET, plain(VT_HRESULT),
        [['pwidth', pointer(named('OLE_XSIZE_HIMETRIC')), RETVAL]]],
    ['Height', INVOKE_PROPERTYGET, plain(VT_HRESULT),
        [['pheight', pointer(named('OLE_YSIZE_HIMETRIC')), RETVAL]]],
    ['Render', INVOKE_FUNC, plain(VT_HRESULT), [['hdc', plain(VT_INT), IN], ['x', plain(VT_I4), IN],
        ['y', plain(VT_I4), IN], ['cx', plain(VT_I4), IN], ['cy', plain(VT_I4), IN],
        ['xSrc', named('OLE_XPOS_HIMETRIC'), IN], ['ySrc', named('OLE_YPOS_HIMETRIC'), IN],
        ['cxSrc', named('OLE_XSIZE_HIMETRIC'), IN], ['cySrc', named('OLE_YSIZE_HIMETRIC'), IN],
        ['prcWBounds', pointer(plain(VT_VOID)), IN]]],
    ['hPal', INVOKE_PROPERTYPUT, plain(VT_HRESULT), [['phpal', named('OLE_HANDLE'), IN]]],
    ['CurDC', INVOKE_PROPERTYGET, plain(VT_HRESULT), [['phdcOut', pointer(plain(VT_INT)), RETVAL]]],
    ['SelectPicture', INVOKE_FUNC, plain(VT_HRESULT), [['hdcIn', plain(VT_INT), IN],
        ['phdcOut', pointer(plain(VT_INT)), OUT], ['phbmpOut', pointer(named('OLE_HANDLE')), OUT]]],
    ['KeepOriginalFormat', INVOKE_PROPERTYGET, plain(VT_HRESULT),
        [['pfkeep', pointer(plain(VT_BOOL)), RETVAL]]],
    ['KeepOriginalFormat', INVOKE_PROPERTYPUT, plain(VT_HRESULT), [['pfkeep', plain(VT_BOOL), IN]]],
    ['PictureChanged', INVOKE_FUNC, plain(VT_HRESULT), []],
    ['SaveAsFile', INVOKE_FUNC, plain(VT_HRESULT), [['pstm', pointer(plain(VT_VOID)), IN],
        ['fSaveMemCopy', plain(VT_BOOL), IN], ['pcbSize', pointer(plain(VT_I4)), OUT]]],
    ['Attributes', INVOKE_PROPERTYGET, plain(VT_HRESULT),
        [['pdwAttr', pointer(plain(VT_I4)), RETVAL]]],
    ['SetHdc', INVOKE_FUNC, plain(VT_HRESULT), [['hdc', named('OLE_HANDLE'), IN]]],
], 3);

const RESTRICTED = { flags: FUNCFLAG_FRESTRICTED };

/** @type {TypeInfoDescription[]} */
const TYPES = [
    type('GUID', TKIND_RECORD, { instanceSize: 16, variables: fields([
        ['Data1', plain(VT_UI4), 4], ['Data2', plain(VT_UI2), 2], ['Data3', plain(VT_UI2), 2],
        ['Data4', { vt: VT_CARRAY, element: null, hreftype: -1,
            array: { element: plain(VT_UI1), bounds: [{ elements: 8, lower: 0 }] } }, 8]]) }),
    type('DISPPARAMS', TKIND_RECORD, { instanceSize: 16, variables: fields([
        ['rgvarg', pointer(plain(VT_VARIANT)), 4], ['rgdispidNamedArgs', pointer(plain(VT_I4)), 4],
        ['cArgs', plain(VT_UINT), 4], ['cNamedArgs', plain(VT_UINT), 4]]) }),
    type('EXCEPINFO', TKIND_RECORD, { instanceSize: 32, variables: fields([
        ['wCode', plain(VT_UI2), 2], ['wReserved', plain(VT_UI2), 2],
        ['bstrSource', plain(VT_BSTR), 4], ['bstrDescription', plain(VT_BSTR), 4],
        ['bstrHelpFile', plain(VT_BSTR), 4], ['dwHelpContext', plain(VT_UI4), 4],
        ['pvReserved', pointer(plain(VT_VOID)), 4],
        ['pfnDeferredFillIn', pointer(plain(VT_VOID)), 4],
        ['scode', plain(VT_ERROR), 4]]) }),
    type('IUnknown', TKIND_INTERFACE, { guid: '{00000000-0000-0000-C000-000000000046}',
        flags: TYPEFLAG_FHIDDEN, vtableSize: 12, functions: [
            fn('QueryInterface', 0x60000000, 0, RESTRICTED, [
                ['riid', pointer(named('GUID')), IN],
                ['ppvObj', pointer(pointer(plain(VT_VOID))), OUT]]),
            fn('AddRef', 0x60000001, 1, { ...RESTRICTED, returns: plain(VT_UI4) }, []),
            fn('Release', 0x60000002, 2, { ...RESTRICTED, returns: plain(VT_UI4) }, []),
        ] }),
    type('IDispatch', TKIND_INTERFACE, { guid: '{00020400-0000-0000-C000-000000000046}',
        flags: TYPEFLAG_FRESTRICTED, vtableSize: DISPATCH_VTABLE,
        implementedTypes: [{ hreftype: UNKNOWN.hreftype, flags: 0 }], functions: [
            fn('GetTypeInfoCount', 0x60010000, 3, RESTRICTED,
                [['pctinfo', pointer(plain(VT_UINT)), OUT]]),
            fn('GetTypeInfo', 0x60010001, 4, RESTRICTED, [['itinfo', plain(VT_UINT), IN],
                ['lcid', plain(VT_UI4), IN], ['pptinfo', pointer(pointer(plain(VT_VOID))), OUT]]),
            fn('GetIDsOfNames', 0x60010002, 5, RESTRICTED, [['riid', pointer(named('GUID')), IN],
                ['rgszNames', pointer(pointer(plain(VT_I1))), IN], ['cNames', plain(VT_UINT), IN],
                ['lcid', plain(VT_UI4), IN], ['rgdispid', pointer(plain(VT_I4)), OUT]]),
            fn('Invoke', 0x60010003, 6, RESTRICTED, [['dispidMember', plain(VT_I4), IN],
                ['riid', pointer(named('GUID')), IN], ['lcid', plain(VT_UI4), IN],
                ['wFlags', plain(VT_UI2), IN], ['pdispparams', pointer(named('DISPPARAMS')), IN],
                ['pvarResult', pointer(plain(VT_VARIANT)), OUT],
                ['pexcepinfo', pointer(named('EXCEPINFO')), OUT],
                ['puArgErr', pointer(plain(VT_UINT)), OUT]]),
        ] }),
    type('IEnumVARIANT', TKIND_INTERFACE, { guid: '{00020404-0000-0000-C000-000000000046}',
        flags: TYPEFLAG_FHIDDEN, vtableSize: 28,
        implementedTypes: [{ hreftype: UNKNOWN.hreftype, flags: 0 }], functions: methods(2, [
            ['Next', INVOKE_FUNC, plain(VT_HRESULT), [['celt', plain(VT_UI4), IN],
                ['rgvar', pointer(plain(VT_VARIANT)), IN],
                ['pceltFetched', pointer(plain(VT_UI4)), OUT]]],
            ['Skip', INVOKE_FUNC, plain(VT_HRESULT), [['celt', plain(VT_UI4), IN]]],
            ['Reset', INVOKE_FUNC, plain(VT_HRESULT), []],
            ['Clone', INVOKE_FUNC, plain(VT_HRESULT),
                [['ppenum', pointer(pointer(named('IEnumVARIANT'))), OUT]]],
        ], 3) }),
    alias('OLE_COLOR', '{66504301-BE0F-101A-8BBB-00AA00300CAB}', plain(VT_UI4)),
    alias('OLE_XPOS_PIXELS', '{66504302-BE0F-101A-8BBB-00AA00300CAB}', plain(VT_I4)),
    alias('OLE_YPOS_PIXELS', '{66504303-BE0F-101A-8BBB-00AA00300CAB}', plain(VT_I4)),
    alias('OLE_XSIZE_PIXELS', '{66504304-BE0F-101A-8BBB-00AA00300CAB}', plain(VT_I4)),
    alias('OLE_YSIZE_PIXELS', '{66504305-BE0F-101A-8BBB-00AA00300CAB}', plain(VT_I4)),
    alias('OLE_XPOS_HIMETRIC', '{66504306-BE0F-101A-8BBB-00AA00300CAB}', plain(VT_I4)),
    alias('OLE_YPOS_HIMETRIC', '{66504307-BE0F-101A-8BBB-00AA00300CAB}', plain(VT_I4)),
    alias('OLE_XSIZE_HIMETRIC', '{66504308-BE0F-101A-8BBB-00AA00300CAB}', plain(VT_I4)),
    alias('OLE_YSIZE_HIMETRIC', '{66504309-BE0F-101A-8BBB-00AA00300CAB}', plain(VT_I4)),
    alias('OLE_XPOS_CONTAINER', '{BF030640-9069-101B-AE2D-08002B2EC713}', plain(VT_R4)),
    alias('OLE_YPOS_CONTAINER', '{BF030641-9069-101B-AE2D-08002B2EC713}', plain(VT_R4)),
    alias('OLE_XSIZE_CONTAINER', '{BF030642-9069-101B-AE2D-08002B2EC713}', plain(VT_R4)),
    alias('OLE_YSIZE_CONTAINER', '{BF030643-9069-101B-AE2D-08002B2EC713}', plain(VT_R4)),
    alias('OLE_HANDLE', '{66504313-BE0F-101A-8BBB-00AA00300CAB}', plain(VT_INT)),
    alias('OLE_OPTEXCLUSIVE', '{6650430B-BE0F-101A-8BBB-00AA00300CAB}', plain(VT_BOOL)),
    alias('OLE_CANCELBOOL', '{BF030644-9069-101B-AE2D-08002B2EC713}', plain(VT_BOOL)),
    alias('OLE_ENABLEDEFAULTBOOL', '{BF030645-9069-101B-AE2D-08002B2EC713}', plain(VT_BOOL)),
    type('OLE_TRISTATE', TKIND_ENUM, { guid: '{6650430A-BE0F-101A-8BBB-00AA00300CAB}',
        variables: constants([['Unchecked', 0], ['Checked', 1], ['Gray', 2]]) }),
    alias('FONTNAME', '{6650430D-BE0F-101A-8BBB-00AA00300CAB}', plain(VT_BSTR)),
    alias('FONTSIZE', '{6650430E-BE0F-101A-8BBB-00AA00300CAB}', plain(VT_CY)),
    alias('FONTBOLD', '{6650430F-BE0F-101A-8BBB-00AA00300CAB}', plain(VT_BOOL)),
    alias('FONTITALIC', '{66504310-BE0F-101A-8BBB-00AA00300CAB}', plain(VT_BOOL)),
    alias('FONTUNDERSCORE', '{66504311-BE0F-101A-8BBB-00AA00300CAB}', plain(VT_BOOL)),
    alias('FONTSTRIKETHROUGH', '{66504312-BE0F-101A-8BBB-00AA00300CAB}', plain(VT_BOOL)),
    type('IFont', TKIND_INTERFACE, { guid: '{BEF6E002-A874-101A-8BBA-00AA00300CAB}',
        flags: TYPEFLAG_FHIDDEN, helpString: 'Font Object',
        vtableSize: 12 + IFONT_METHODS.length * 4,
        implementedTypes: [{ hreftype: UNKNOWN.hreftype, flags: 0 }], functions: IFONT_METHODS }),
    type('Font', TKIND_DISPATCH, { guid: '{BEF6E003-A874-101A-8BBA-00AA00300CAB}',
        flags: TYPEFLAG_FDISPATCHABLE, vtableSize: DISPATCH_VTABLE,
        implementedTypes: [{ hreftype: DISPATCH.hreftype, flags: 0 }],
        variables: properties([['Name', 0, plain(VT_BSTR), false], ['Size', 2, plain(VT_CY), false],
            ['Bold', 3, plain(VT_BOOL), false], ['Italic', 4, plain(VT_BOOL), false],
            ['Underline', 5, plain(VT_BOOL), false], ['Strikethrough', 6, plain(VT_BOOL), false],
            ['Weight', 7, plain(VT_I2), false], ['Charset', 8, plain(VT_I2), false]]) }),
    alias('IFontDisp', '', named('Font')),
    type('StdFont', TKIND_COCLASS, { guid: '{0BE35203-8F91-11CE-9DE3-00AA004BB851}',
        flags: TYPEFLAG_FCANCREATE, implementedTypes: [
            { hreftype: hrefOf('Font'), flags: IMPLTYPEFLAG_FDEFAULT },
            { hreftype: hrefOf('IFont'), flags: 0 }] }),
    type('IPicture', TKIND_INTERFACE, { guid: '{7BF80980-BF32-101A-8BBB-00AA00300CAB}',
        flags: TYPEFLAG_FHIDDEN, helpString: 'Picture Object',
        vtableSize: 12 + IPICTURE_METHODS.length * 4,
        implementedTypes: [{ hreftype: UNKNOWN.hreftype, flags: 0 }],
        functions: IPICTURE_METHODS }),
    type('Picture', TKIND_DISPATCH, { guid: '{7BF80981-BF32-101A-8BBB-00AA00300CAB}',
        flags: TYPEFLAG_FDISPATCHABLE, vtableSize: DISPATCH_VTABLE,
        implementedTypes: [{ hreftype: DISPATCH.hreftype, flags: 0 }],
        variables: properties([['Handle', 0, named('OLE_HANDLE'), true],
            ['hPal', 2, named('OLE_HANDLE'), false], ['Type', 3, plain(VT_I2), true],
            ['Width', 4, named('OLE_XSIZE_HIMETRIC'), true],
            ['Height', 5, named('OLE_YSIZE_HIMETRIC'), true]]),
        functions: [fn('Render', 6, -1, { funcKind: FUNC_DISPATCH, returns: plain(VT_VOID) }, [
            ['hdc', plain(VT_INT), 0], ['x', plain(VT_I4), 0], ['y', plain(VT_I4), 0],
            ['cx', plain(VT_I4), 0], ['cy', plain(VT_I4), 0],
            ['xSrc', named('OLE_XPOS_HIMETRIC'), 0], ['ySrc', named('OLE_YPOS_HIMETRIC'), 0],
            ['cxSrc', named('OLE_XSIZE_HIMETRIC'), 0], ['cySrc', named('OLE_YSIZE_HIMETRIC'), 0],
            ['prcWBounds', pointer(plain(VT_VOID)), 0]])] }),
    alias('IPictureDisp', '', named('Picture')),
    type('StdPicture', TKIND_COCLASS, { guid: '{0BE35204-8F91-11CE-9DE3-00AA004BB851}',
        flags: TYPEFLAG_FCANCREATE, implementedTypes: [
            { hreftype: hrefOf('Picture'), flags: IMPLTYPEFLAG_FDEFAULT },
            { hreftype: hrefOf('IPicture'), flags: 0 }] }),
    type('LoadPictureConstants', TKIND_ENUM, { guid: '{E6C8FA08-BD9F-11D0-985E-00C04FC29993}',
        variables: constants([['Default', 0], ['Monochrome', 1], ['VgaColor', 2],
            ['Color', 4]]) }),
    type('StdFunctions', TKIND_MODULE, { guid: '{91209AC0-60F6-11CF-9C5D-00AA00C1489E}',
        helpString: 'Functions for Standard OLE Objects', instanceSize: 2, alignment: 2,
        functions: [
            fn('LoadPicture', 0x60000000, -1, { funcKind: FUNC_STATIC, optionalParameters: 0,
                helpString: 'Loads a picture from a file' }, [
                ['filename', plain(VT_VARIANT), IN | PARAMFLAG_FOPT],
                ['widthDesired', plain(VT_INT), IN | PARAMFLAG_FOPT | PARAMFLAG_FHASDEFAULT],
                ['heightDesired', plain(VT_INT), IN | PARAMFLAG_FOPT | PARAMFLAG_FHASDEFAULT],
                ['flags', named('LoadPictureConstants'),
                    IN | PARAMFLAG_FOPT | PARAMFLAG_FHASDEFAULT],
                ['retval', pointer(pointer(named('IPictureDisp'))), RETVAL]]),
            fn('SavePicture', 0x60000001, -1, { funcKind: FUNC_STATIC,
                helpString: 'Saves a picture to a file' }, [
                ['Picture', pointer(named('IPictureDisp')), IN],
                ['filename', plain(VT_BSTR), IN]]),
        ] }),
    type('FontEvents', TKIND_DISPATCH, { guid: '{4EF6100A-AF88-11D0-9846-00C04FC29993}',
        flags: TYPEFLAG_FHIDDEN | TYPEFLAG_FDISPATCHABLE, vtableSize: DISPATCH_VTABLE,
        helpString: 'Event Interface for the Font Object',
        implementedTypes: [{ hreftype: DISPATCH.hreftype, flags: 0 }],
        functions: [fn('FontChanged', 9, -1, { funcKind: FUNC_DISPATCH, returns: plain(VT_VOID) },
            [['PropertyName', plain(VT_BSTR), IN]])] }),
    alias('IFontEventsDisp', '', named('FontEvents')),
].map(described=>(described.guid === '' ? { ...described, guid: null } : described));

/** @type {TypeLibrary} */
export const STDOLE2 = Object.freeze({
    name: 'stdole',
    guid: STDOLE_GUID,
    lcid: 0,
    sysKind: 1,
    majorVersion: 2,
    minorVersion: 0,
    flags: 0,
    helpString: 'OLE Automation',
    helpFile: null,
    typeInfos: TYPES,
    imports: [],
});

/**
 * Whether a library a program names is the system's stdole: stdole2.tlb,
 * with or without the system directory in front of it.
 *
 * @param {string} path
 */
export const isStdole = path=>/(^|[\\/])stdole2\.tlb$/i.test(path);
