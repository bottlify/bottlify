#
# Copyright © 2026 Bottlify Project
# Licensed under the Mozilla Public License, version 2.0
# See LICENSE for details
#
param([string]$Source, [string]$Profile, [string]$Entry, [string]$Out, [string]$List)
# Reference compiles through the system's D3DCompiler_47, includes resolved beside the
# source: each bytecode to its .bin, messages and disassembly to the .bin.txt. One
# shader from the arguments, or every line of -List ("source|profile|entry|out") in one
# process, since loading the compiler costs more than a compile.
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
    static IntPtr Ptr(IntPtr blob) {
        IntPtr vt = Marshal.ReadIntPtr(blob);
        return ((GetPtr)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vt, 3 * IntPtr.Size), typeof(GetPtr)))(blob);
    }
    static int Size(IntPtr blob) {
        IntPtr vt = Marshal.ReadIntPtr(blob);
        return (int)((GetSize)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vt, 4 * IntPtr.Size), typeof(GetSize)))(blob);
    }
    static string Text(IntPtr blob) {
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
'@
if ($List) {
    foreach ($line in [System.IO.File]::ReadAllLines($List)) {
        if ($line.Trim() -eq '') { continue }
        $f = $line.Split('|')
        if (Test-Path "$($f[3])") { Remove-Item "$($f[3])" }
        [System.IO.File]::WriteAllText("$($f[3]).txt", [Fxc]::Run($f[0], $f[1], $f[2], $f[3]))
    }
} else {
    [System.IO.File]::WriteAllText("$Out.txt", [Fxc]::Run((Resolve-Path $Source).Path, $Profile, $Entry, $Out))
}
