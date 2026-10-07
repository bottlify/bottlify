/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The exports of shlwapi that are nothing but another library's function under
 * a number: the "Wrap" functions a program of the Windows 9x era imports by
 * ordinal to call a wide-character API that system did not have, which here
 * (and on every system since) are the library's own function.
 *
 * Each is [ordinal, the name it is known by, the library and function it is, and
 * how many words of arguments it takes]. The count is the wrapper's -- how much
 * it takes off the stack -- and the target is handed what the caller passed.
 *
 * @type {readonly (readonly [number, string, string, string, number])[]}
 */
export const SHLWAPI_FORWARDS = Object.freeze([
    [25, 'IsCharAlphaWrapW', 'USER32.dll', 'IsCharAlphaW', 1],
    [26, 'IsCharUpperWrapW', 'USER32.dll', 'IsCharUpperW', 1],
    [27, 'IsCharLowerWrapW', 'USER32.dll', 'IsCharLowerW', 1],
    [28, 'IsCharAlphaNumericWrapW', 'USER32.dll', 'IsCharAlphaNumericW', 1],
    [36, 'AppendMenuWrapW', 'USER32.dll', 'AppendMenuW', 4],
    [37, 'CallWindowProcWrapW', 'USER32.dll', 'CallWindowProcW', 5],
    [38, 'CharLowerWrapW', 'USER32.dll', 'CharLowerW', 1],
    [39, 'CharLowerBuffWrapW', 'USER32.dll', 'CharLowerBuffW', 2],
    [40, 'CharNextWrapW', 'USER32.dll', 'CharNextW', 1],
    [41, 'CharPrevWrapW', 'USER32.dll', 'CharPrevW', 2],
    [42, 'CharToOemWrapW', 'USER32.dll', 'CharToOemW', 1],
    [43, 'CharUpperWrapW', 'USER32.dll', 'CharUpperW', 1],
    [44, 'CharUpperBuffWrapW', 'USER32.dll', 'CharUpperBuffW', 2],
    [45, 'CompareStringWrapW', 'KERNEL32.dll', 'CompareStringW', 6],
    [46, 'CopyAcceleratorTableWrapW', 'USER32.dll', 'CopyAcceleratorTableW', 3],
    [47, 'CreateAcceleratorTableWrapW', 'USER32.dll', 'CreateAcceleratorTableW', 2],
    [48, 'CreateDCWrapW', 'GDI32.dll', 'CreateDCW', 4],
    [49, 'CreateDialogParamWrapW', 'USER32.dll', 'CreateDialogParamW', 5],
    [50, 'CreateDirectoryWrapW', 'KERNEL32.dll', 'CreateDirectoryW', 2],
    [51, 'CreateEventWrapW', 'KERNEL32.dll', 'CreateEventW', 4],
    [52, 'CreateFileWrapW', 'KERNEL32.dll', 'CreateFileW', 7],
    [53, 'CreateFontIndirectWrapW', 'GDI32.dll', 'CreateFontIndirectW', 1],
    [54, 'CreateICWrapW', 'GDI32.dll', 'CreateICW', 4],
    [55, 'CreateWindowExWrapW', 'USER32.dll', 'CreateWindowExW', 12],
    [56, 'DefWindowProcWrapW', 'USER32.dll', 'DefWindowProcW', 4],
    [57, 'DeleteFileWrapW', 'KERNEL32.dll', 'DeleteFileW', 1],
    [58, 'DialogBoxIndirectParamWrapW', 'USER32.dll', 'DialogBoxIndirectParamW', 5],
    [59, 'DialogBoxParamWrapW', 'USER32.dll', 'DialogBoxParamW', 5],
    [60, 'DispatchMessageWrapW', 'USER32.dll', 'DispatchMessageW', 1],
    [61, 'DrawTextWrapW', 'USER32.dll', 'DrawTextW', 5],
    [62, 'EnumFontFamiliesWrapW', 'GDI32.dll', 'EnumFontFamiliesW', 4],
    [63, 'EnumFontFamiliesExWrapW', 'GDI32.dll', 'EnumFontFamiliesExW', 5],
    [64, 'EnumResourceNamesWrapW', 'KERNEL32.dll', 'EnumResourceNamesW', 4],
    [65, 'FindFirstFileWrapW', 'KERNEL32.dll', 'FindFirstFileW', 2],
    [66, 'FindResourceWrapW', 'KERNEL32.dll', 'FindResourceW', 3],
    [67, 'FindWindowWrapW', 'USER32.dll', 'FindWindowW', 2],
    [68, 'FormatMessageWrapW', 'KERNEL32.dll', 'FormatMessageW', 7],
    [69, 'GetClassInfoWrapW', 'USER32.dll', 'GetClassInfoW', 3],
    [70, 'GetClassLongWrapW', 'USER32.dll', 'GetClassLongW', 2],
    [71, 'GetClassNameWrapW', 'USER32.dll', 'GetClassNameW', 3],
    [72, 'GetClipboardFormatNameWrapW', 'USER32.dll', 'GetClipboardFormatNameW', 3],
    [73, 'GetCurrentDirectoryWrapW', 'KERNEL32.dll', 'GetCurrentDirectoryW', 2],
    [74, 'GetDlgItemTextWrapW', 'USER32.dll', 'GetDlgItemTextW', 4],
    [75, 'GetFileAttributesWrapW', 'KERNEL32.dll', 'GetFileAttributesW', 1],
    [76, 'GetFullPathNameWrapW', 'KERNEL32.dll', 'GetFullPathNameW', 4],
    [77, 'GetLocaleInfoWrapW', 'KERNEL32.dll', 'GetLocaleInfoW', 4],
    [78, 'GetMenuStringWrapW', 'USER32.dll', 'GetMenuStringW', 5],
    [79, 'GetMessageWrapW', 'USER32.dll', 'GetMessageW', 4],
    [80, 'GetModuleFileNameWrapW', 'KERNEL32.dll', 'GetModuleFileNameW', 3],
    [81, 'GetSystemDirectoryWrapW', 'KERNEL32.dll', 'GetSystemDirectoryW', 2],
    [82, 'SearchPathWrapW', 'KERNEL32.dll', 'SearchPathW', 6],
    [83, 'GetModuleHandleWrapW', 'KERNEL32.dll', 'GetModuleHandleW', 1],
    [84, 'GetObjectWrapW', 'GDI32.dll', 'GetObjectW', 3],
    [85, 'GetPrivateProfileIntWrapW', 'KERNEL32.dll', 'GetPrivateProfileIntW', 4],
    [86, 'GetProfileStringWrapW', 'KERNEL32.dll', 'GetProfileStringW', 5],
    [87, 'GetPropWrapW', 'USER32.dll', 'GetPropW', 2],
    [88, 'GetStringTypeExWrapW', 'KERNEL32.dll', 'GetStringTypeExW', 5],
    [89, 'GetTempFileNameWrapW', 'KERNEL32.dll', 'GetTempFileNameW', 4],
    [90, 'GetTempPathWrapW', 'KERNEL32.dll', 'GetTempPathW', 2],
    [91, 'GetTextExtentPoint32WrapW', 'GDI32.dll', 'GetTextExtentPoint32W', 4],
    [92, 'GetTextFaceWrapW', 'GDI32.dll', 'GetTextFaceW', 3],
    [93, 'GetTextMetricsWrapW', 'GDI32.dll', 'GetTextMetricsW', 2],
    [94, 'GetWindowLongWrapW', 'USER32.dll', 'GetWindowLongW', 2],
    [95, 'GetWindowTextWrapW', 'USER32.dll', 'GetWindowTextW', 3],
    [96, 'GetWindowTextLengthWrapW', 'USER32.dll', 'GetWindowTextLengthW', 1],
    [97, 'GetWindowsDirectoryWrapW', 'KERNEL32.dll', 'GetWindowsDirectoryW', 2],
    [98, 'InsertMenuWrapW', 'USER32.dll', 'InsertMenuW', 5],
    [99, 'IsDialogMessageWrapW', 'USER32.dll', 'IsDialogMessageW', 2],
    [100, 'LoadAcceleratorsWrapW', 'USER32.dll', 'LoadAcceleratorsW', 2],
    [101, 'LoadBitmapWrapW', 'USER32.dll', 'LoadBitmapW', 2],
    [102, 'LoadCursorWrapW', 'USER32.dll', 'LoadCursorW', 2],
    [103, 'LoadIconWrapW', 'USER32.dll', 'LoadIconW', 2],
    [104, 'LoadImageWrapW', 'USER32.dll', 'LoadImageW', 6],
    [105, 'LoadLibraryExWrapW', 'KERNEL32.dll', 'LoadLibraryExW', 3],
    [106, 'LoadMenuWrapW', 'USER32.dll', 'LoadMenuW', 2],
    [107, 'LoadStringWrapW', 'USER32.dll', 'LoadStringW', 4],
    [108, 'MessageBoxIndirectWrapW', 'USER32.dll', 'MessageBoxIndirectW', 1],
    [109, 'ModifyMenuWrapW', 'USER32.dll', 'ModifyMenuW', 5],
    [110, 'GetCharWidth32WrapW', 'GDI32.dll', 'GetCharWidth32W', 4],
    [111, 'GetCharacterPlacementWrapW', 'GDI32.dll', 'GetCharacterPlacementW', 6],
    [112, 'CopyFileWrapW', 'KERNEL32.dll', 'CopyFileW', 3],
    [113, 'MoveFileWrapW', 'KERNEL32.dll', 'MoveFileW', 2],
    [114, 'OemToCharWrapW', 'USER32.dll', 'OemToCharW', 2],
    [115, 'OutputDebugStringWrapW', 'KERNEL32.dll', 'OutputDebugStringW', 1],
    [116, 'PeekMessageWrapW', 'USER32.dll', 'PeekMessageW', 5],
    [117, 'PostMessageWrapW', 'USER32.dll', 'PostMessageW', 4],
    [118, 'PostThreadMessageWrapW', 'USER32.dll', 'PostThreadMessageW', 4],
    [119, 'RegCreateKeyWrapW', 'ADVAPI32.dll', 'RegCreateKeyW', 3],
    [120, 'RegCreateKeyExWrapW', 'ADVAPI32.dll', 'RegCreateKeyExW', 9],
    [121, 'RegDeleteKeyWrapW', 'ADVAPI32.dll', 'RegDeleteKeyW', 2],
    [122, 'RegEnumKeyWrapW', 'ADVAPI32.dll', 'RegEnumKeyW', 4],
    [123, 'RegEnumKeyExWrapW', 'ADVAPI32.dll', 'RegEnumKeyExW', 8],
    [124, 'RegOpenKeyWrapW', 'ADVAPI32.dll', 'RegOpenKeyW', 3],
    [125, 'RegOpenKeyExWrapW', 'ADVAPI32.dll', 'RegOpenKeyExW', 5],
    [126, 'RegQueryInfoKeyWrapW', 'ADVAPI32.dll', 'RegQueryInfoKeyW', 12],
    [127, 'RegQueryValueWrapW', 'ADVAPI32.dll', 'RegQueryValueW', 4],
    [128, 'RegQueryValueExWrapW', 'ADVAPI32.dll', 'RegQueryValueExW', 6],
    [129, 'RegSetValueWrapW', 'ADVAPI32.dll', 'RegSetValueW', 5],
    [130, 'RegSetValueExWrapW', 'ADVAPI32.dll', 'RegSetValueExW', 6],
    [131, 'RegisterClassWrapW', 'USER32.dll', 'RegisterClassW', 1],
    [132, 'RegisterClipboardFormatWrapW', 'USER32.dll', 'RegisterClipboardFormatW', 1],
    [133, 'RegisterWindowMessageWrapW', 'USER32.dll', 'RegisterWindowMessageW', 1],
    [134, 'RemovePropWrapW', 'USER32.dll', 'RemovePropW', 2],
    [135, 'SendDlgItemMessageWrapW', 'USER32.dll', 'SendDlgItemMessageW', 5],
    [136, 'SendMessageWrapW', 'USER32.dll', 'SendMessageW', 4],
    [137, 'SetCurrentDirectoryWrapW', 'KERNEL32.dll', 'SetCurrentDirectoryW', 1],
    [138, 'SetDlgItemTextWrapW', 'USER32.dll', 'SetDlgItemTextW', 3],
    [139, 'SetMenuItemInfoWrapW', 'USER32.dll', 'SetMenuItemInfoW', 4],
    [140, 'SetPropWrapW', 'USER32.dll', 'SetPropW', 3],
    [141, 'SetWindowLongWrapW', 'USER32.dll', 'SetWindowLongW', 3],
    [142, 'SetWindowsHookExWrapW', 'USER32.dll', 'SetWindowsHookExW', 4],
    [143, 'SetWindowTextWrapW', 'USER32.dll', 'SetWindowTextW', 2],
    [144, 'StartDocWrapW', 'GDI32.dll', 'StartDocW', 2],
    [145, 'SystemParametersInfoWrapW', 'USER32.dll', 'SystemParametersInfoW', 4],
    [146, 'TranslateAcceleratorWrapW', 'USER32.dll', 'TranslateAcceleratorW', 3],
    [147, 'UnregisterClassWrapW', 'USER32.dll', 'UnregisterClassW', 2],
    [148, 'VkKeyScanWrapW', 'USER32.dll', 'VkKeyScanW', 1],
    [149, 'WinHelpWrapW', 'USER32.dll', 'WinHelpW', 4],
    [150, 'wvsprintfWrapW', 'USER32.dll', 'wvsprintfW', 3],
    [159, 'CompareStringAltW', 'KERNEL32.dll', 'CompareStringW', 6],
    [298, 'WritePrivateProfileStringWrapW', 'KERNEL32.dll', 'WritePrivateProfileStringW', 4],
    [299, 'ExtTextOutWrapW', 'GDI32.dll', 'ExtTextOutW', 8],
    [300, 'CreateFontWrapW', 'GDI32.dll', 'CreateFontW', 14],
    [301, 'DrawTextExWrapW', 'USER32.dll', 'DrawTextExW', 6],
    [302, 'GetMenuItemInfoWrapW', 'USER32.dll', 'GetMenuItemInfoW', 4],
    [303, 'InsertMenuItemWrapW', 'USER32.dll', 'InsertMenuItemW', 4],
    [304, 'CreateMetaFileWrapW', 'GDI32.dll', 'CreateMetaFileW', 1],
    [305, 'CreateMutexWrapW', 'KERNEL32.dll', 'CreateMutexW', 3],
    [306, 'ExpandEnvironmentStringsWrapW', 'KERNEL32.dll', 'ExpandEnvironmentStringsW', 3],
    [307, 'CreateSemaphoreWrapW', 'KERNEL32.dll', 'CreateSemaphoreW', 4],
    [308, 'IsBadStringPtrWrapW', 'KERNEL32.dll', 'IsBadStringPtrW', 2],
    [309, 'LoadLibraryWrapW', 'KERNEL32.dll', 'LoadLibraryW', 1],
    [310, 'GetTimeFormatWrapW', 'KERNEL32.dll', 'GetTimeFormatW', 6],
    [311, 'GetDateFormatWrapW', 'KERNEL32.dll', 'GetDateFormatW', 6],
    [312, 'GetPrivateProfileStringWrapW', 'KERNEL32.dll', 'GetPrivateProfileStringW', 6],
    [314, 'RegisterClassExWrapW', 'USER32.dll', 'RegisterClassExW', 1],
    [315, 'GetClassInfoExWrapW', 'USER32.dll', 'GetClassInfoExW', 3],
    [319, 'FindWindowExWrapW', 'USER32.dll', 'FindWindowExW', 4],
    [332, 'CallMsgFilterWrapW', 'USER32.dll', 'CallMsgFilterW', 2],
    [337, 'ExtractIconExWrapW', 'USER32.dll', 'PrivateExtractIconExW', 5],
    [338, 'SetFileAttributesWrapW', 'KERNEL32.dll', 'SetFileAttributesW', 2],
    [339, 'GetNumberFormatWrapW', 'KERNEL32.dll', 'GetNumberFormatW', 6],
    [340, 'MessageBoxWrapW', 'USER32.dll', 'MessageBoxW', 4],
    [341, 'FindNextFileWrapW', 'KERNEL32.dll', 'FindNextFileW', 2],
    [347, 'RegDeleteValueWrapW', 'ADVAPI32.dll', 'RegDeleteValueW', 2],
    [359, 'OpenEventWrapW', 'KERNEL32.dll', 'OpenEventW', 3],
    [360, 'RemoveDirectoryWrapW', 'KERNEL32.dll', 'RemoveDirectoryW', 1],
    [361, 'GetShortPathNameWrapW', 'KERNEL32.dll', 'GetShortPathNameW', 3],
    [362, 'GetUserNameWrapW', 'ADVAPI32.dll', 'GetUserNameW', 2],
    [366, 'RegEnumValueWrapW', 'ADVAPI32.dll', 'RegEnumValueW', 8],
    [367, 'WritePrivateProfileStructWrapW', 'KERNEL32.dll', 'WritePrivateProfileStructW', 5],
    [368, 'GetPrivateProfileStructWrapW', 'KERNEL32.dll', 'GetPrivateProfileStructW', 5],
    [369, 'CreateProcessWrapW', 'KERNEL32.dll', 'CreateProcessW', 10],
    [371, 'DdeInitializeWrapW', 'USER32.dll', 'DdeInitializeW', 4],
    [372, 'DdeCreateStringHandleWrapW', 'USER32.dll', 'DdeCreateStringHandleW', 3],
    [373, 'DdeQueryStringWrapW', 'USER32.dll', 'DdeQueryStringW', 5],
    [376, 'MLGetUILanguage', 'KERNEL32.dll', 'GetUserDefaultUILanguage', 0],
    [392, 'EndDialogWrap', 'USER32.dll', 'EndDialog', 2],
    [393, 'CreateDialogIndirectParamWrapW', 'USER32.dll', 'CreateDialogIndirectParamW', 5],
    [425, 'DeleteMenuWrap', 'USER32.dll', 'DeleteMenu', 3],
    [426, 'DestroyMenuWrap', 'USER32.dll', 'DestroyMenu', 1],
    [427, 'TrackPopupMenuWrap', 'USER32.dll', 'TrackPopupMenu', 7],
    [428, 'TrackPopupMenuExWrap', 'USER32.dll', 'TrackPopupMenuEx', 6],
    [434, 'SendMessageTimeoutWrapW', 'USER32.dll', 'SendMessageTimeoutW', 7],
    [435, 'CLSIDFromProgIDWrap', 'OLE32.dll', 'CLSIDFromProgID', 2],
    [442, 'GetEnvironmentVariableWrapW', 'KERNEL32.dll', 'GetEnvironmentVariableW', 3],
    [443, 'SHGetSystemWindowsDirectoryA', 'KERNEL32.dll', 'GetSystemWindowsDirectoryA', 2],
    [444, 'SHGetSystemWindowsDirectoryW', 'KERNEL32.dll', 'GetSystemWindowsDirectoryW', 2],
    [457, 'GetLongPathNameWrapW', 'KERNEL32.dll', 'GetLongPathNameW', 3],
    [458, 'GetLongPathNameWrapA', 'KERNEL32.dll', 'GetLongPathNameA', 3],
    [459, 'SHExpandEnvironmentStringsA', 'KERNEL32.dll', 'ExpandEnvironmentStringsA', 3],
    [460, 'SHExpandEnvironmentStringsW', 'KERNEL32.dll', 'ExpandEnvironmentStringsW', 3],
    [463, 'SHExpandEnvironmentStringsForUserA', 'USERENV.dll',
        'ExpandEnvironmentStringsForUserA', 4],
    [464, 'SHExpandEnvironmentStringsForUserW', 'USERENV.dll',
        'ExpandEnvironmentStringsForUserW', 4],
    [480, 'UrlCrackW', 'WININET.dll', 'InternetCrackUrlW', 4],
    [489, 'GlobalAddAtomWrapW', 'KERNEL32.dll', 'GlobalAddAtomW', 1],
    [490, 'GlobalFindAtomWrapW', 'KERNEL32.dll', 'GlobalFindAtomW', 1],
    [543, 'CreateColorSpaceWrapW', 'GDI32.dll', 'CreateColorSpaceW', 1],
]);

/** The ordinals, as the name each stands for, in the shape the loader is told them in. */
export const SHLWAPI_ORDINALS = Object.freeze(Object.fromEntries(
    SHLWAPI_FORWARDS.map(([ordinal, name])=>[ordinal, name])));

/**
 * The functions of the table above, each answering as its target does.
 *
 * @param {(library: string) => Record<string, { handler: (args: number[]) => any }> | undefined}
 *     library  Another library's exports, asked for when a call is made: the one
 *              that is not there is said so, and answers nothing.
 * @param {(api: string, detail: string) => void} [report]
 * @returns {Record<string, { argBytes: number, handler: (args: number[]) => any }>}
 */
export function createForwards(library, report){
    return Object.fromEntries(SHLWAPI_FORWARDS.map(([ordinal, name, home, target, words])=>[name, {
        argBytes: words * 4,
        /** @param {number[]} args */
        handler: args=>{
            const entry = library(home)?.[target];
            if (!entry)
            {
                report?.('SHLWAPI', `#${ordinal} ${name} is ${home}!${target}, which is not`
                    + ' implemented, and answered 0');
                return 0;
            }
            return entry.handler(args);
        },
    }]));
}
