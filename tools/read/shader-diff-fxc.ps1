#
# Copyright © 2026 Bottlify Project
# Licensed under the Mozilla Public License, version 2.0
# See LICENSE for details
#
param([string]$Source, [string]$Profile, [string]$Entry, [string]$Out, [string]$List,
    [string]$Legacy)
# Reference compiles through the system's D3DCompiler_47, includes resolved beside the
# source: each bytecode to its .bin, messages and disassembly to the .bin.txt. One
# shader from the arguments, or every line of -List ("source|profile|entry|out[|legacy]")
# in one process, since loading the compiler costs more than a compile. A line marked
# legacy goes through D3DXCompileShader of the -Legacy DLL instead: d3dx9_31.dll of the
# DirectX runtime is the last of Microsoft's compilers with the model 1 targets, which
# D3DCompiler_47 refuses.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Fxc {
    [DllImport("D3DCompiler_47.dll", CharSet = CharSet.Ansi)]
    public static extern int D3DCompile(byte[] src, UIntPtr size, string name, IntPtr defines,
        IntPtr include, string entry, string target, uint flags1, uint flags2,
        out IntPtr code, out IntPtr errors);
    [DllImport("D3DCompiler_47.dll")]
    public static extern int D3DDisassemble(IntPtr data, UIntPtr size, uint flags, string comments,
        out IntPtr text);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate IntPtr GetPtr(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate UIntPtr GetSize(IntPtr self);
    public static IntPtr Ptr(IntPtr blob) {
        IntPtr vt = Marshal.ReadIntPtr(blob);
        return ((GetPtr)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vt, 3 * IntPtr.Size), typeof(GetPtr)))(blob);
    }
    public static int Size(IntPtr blob) {
        IntPtr vt = Marshal.ReadIntPtr(blob);
        return (int)((GetSize)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vt, 4 * IntPtr.Size), typeof(GetSize)))(blob);
    }
    public static string Text(IntPtr blob) {
        return blob == IntPtr.Zero ? "" : (Marshal.PtrToStringAnsi(Ptr(blob)) ?? "");
    }
    public static string Run(string path, string target, string entry, string outPath) {
        byte[] src = System.IO.File.ReadAllBytes(path);
        IntPtr code, errors;
        // D3D_COMPILE_STANDARD_FILE_INCLUDE: includes are read relative to the source's name.
        int hr = D3DCompile(src, (UIntPtr)src.Length, path, IntPtr.Zero, (IntPtr)1, entry,
            target, 0, 0, out code, out errors);
        string messages = Text(errors);
        if (hr < 0 || code == IntPtr.Zero) return messages + "FAILED hr=0x" + hr.ToString("x8") + "\n";
        byte[] bytes = new byte[Size(code)];
        Marshal.Copy(Ptr(code), bytes, 0, bytes.Length);
        System.IO.File.WriteAllBytes(outPath, bytes);
        IntPtr text;
        D3DDisassemble(Ptr(code), (UIntPtr)bytes.Length, 0, null, out text);
        return messages + Text(text);
    }
}
public static class Legacy {
    [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr LoadLibraryW(string path);
    [DllImport("kernel32", CharSet = CharSet.Ansi)]
    static extern IntPtr GetProcAddress(IntPtr module, string name);
    [UnmanagedFunctionPointer(CallingConvention.StdCall, CharSet = CharSet.Ansi)]
    delegate int CompileShader(byte[] src, uint size, IntPtr defines, IntPtr include,
        string entry, string profile, uint flags, out IntPtr code, out IntPtr errors, IntPtr table);
    [UnmanagedFunctionPointer(CallingConvention.StdCall, CharSet = CharSet.Ansi)]
    delegate int Disassemble(IntPtr code, int colour, string comments, out IntPtr text);
    static CompileShader compile;
    static Disassemble disassemble;
    public static void Load(string dll) {
        IntPtr module = LoadLibraryW(dll);
        if (module == IntPtr.Zero) throw new Exception("cannot load " + dll + ": error " + Marshal.GetLastWin32Error());
        compile = (CompileShader)Marshal.GetDelegateForFunctionPointer(
            GetProcAddress(module, "D3DXCompileShader"), typeof(CompileShader));
        disassemble = (Disassemble)Marshal.GetDelegateForFunctionPointer(
            GetProcAddress(module, "D3DXDisassembleShader"), typeof(Disassemble));
    }
    // D3DX has no standard include handler: the includes are put in place beforehand.
    static string Inline(string dir, string text, int depth) {
        return System.Text.RegularExpressions.Regex.Replace(text, @"#include\s+""([^""]+)""", m => {
            string path = System.IO.Path.Combine(dir, m.Groups[1].Value);
            return depth < 8 && System.IO.File.Exists(path)
                ? Inline(dir, System.IO.File.ReadAllText(path, System.Text.Encoding.GetEncoding(28591)), depth + 1)
                : m.Value;
        });
    }
    public static string Run(string path, string target, string entry, string outPath) {
        var latin = System.Text.Encoding.GetEncoding(28591);
        byte[] src = latin.GetBytes(Inline(System.IO.Path.GetDirectoryName(path),
            System.IO.File.ReadAllText(path, latin), 0));
        IntPtr code, errors;
        int hr = compile(src, (uint)src.Length, IntPtr.Zero, IntPtr.Zero, entry, target, 0,
            out code, out errors, IntPtr.Zero);
        string messages = Fxc.Text(errors);
        if (hr < 0 || code == IntPtr.Zero) return messages + "FAILED hr=0x" + hr.ToString("x8") + "\n";
        byte[] bytes = new byte[Fxc.Size(code)];
        Marshal.Copy(Fxc.Ptr(code), bytes, 0, bytes.Length);
        System.IO.File.WriteAllBytes(outPath, bytes);
        IntPtr text;
        disassemble(Fxc.Ptr(code), 0, null, out text);
        return messages + Fxc.Text(text);
    }
}
'@
$ErrorActionPreference = "Stop"
if ($Legacy) { [Legacy]::Load((Resolve-Path $Legacy).Path) }
if ($List) {
    foreach ($line in [System.IO.File]::ReadAllLines($List)) {
        if ($line.Trim() -eq '') { continue }
        $f = $line.Split('|')
        if (Test-Path "$($f[3])") { Remove-Item "$($f[3])" }
        $said = if ($f.Length -gt 4 -and $f[4] -eq 'legacy') { [Legacy]::Run($f[0], $f[1], $f[2], $f[3]) }
            else { [Fxc]::Run($f[0], $f[1], $f[2], $f[3]) }
        [System.IO.File]::WriteAllText("$($f[3]).txt", $said)
    }
} else {
    $path = (Resolve-Path $Source).Path
    $said = if ($Legacy) { [Legacy]::Run($path, $Profile, $Entry, $Out) }
        else { [Fxc]::Run($path, $Profile, $Entry, $Out) }
    [System.IO.File]::WriteAllText("$Out.txt", $said)
}
