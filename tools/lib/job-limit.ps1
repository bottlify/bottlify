# Copyright © 2026 Bottlify Project
# Licensed under the Mozilla Public License, version 2.0
# See LICENSE for details
#
# Puts a process and every process under it into one job object whose committed
# memory together may not pass a ceiling. The browser's children join on their
# own once the parent is in; the ones already started are swept in here. Past the
# ceiling an allocation fails and the browser's process dies of it, where without
# one a run that ran away paged the whole machine until it stopped answering.
# The job outlives this script: its processes hold it.
param([Parameter(Mandatory)][int]$ProcessId, [Parameter(Mandatory)][long]$LimitMb)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BottlifyJob {
    [StructLayout(LayoutKind.Sequential)] struct Basic {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] struct Io {
        public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)] struct Extended {
        public Basic BasicLimitInformation; public Io IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref Extended i, int l);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint a, bool i, int id);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x200;
    public static IntPtr Create(long bytes) {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Exception("CreateJobObject " + Marshal.GetLastWin32Error());
        var info = new Extended();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_JOB_MEMORY;
        info.JobMemoryLimit = new UIntPtr((ulong)bytes);
        if (!SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(Extended))))
            throw new Exception("SetInformationJobObject " + Marshal.GetLastWin32Error());
        return job;
    }
    public static bool Assign(IntPtr job, int pid) {
        // PROCESS_SET_QUOTA | PROCESS_TERMINATE
        IntPtr p = OpenProcess(0x0100 | 0x0001, false, pid);
        if (p == IntPtr.Zero) return false;
        bool ok = AssignProcessToJobObject(job, p);
        CloseHandle(p);
        return ok;
    }
}
'@

$job = [BottlifyJob]::Create($LimitMb * 1MB)
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$pending = [System.Collections.Generic.Queue[int]]::new()
$pending.Enqueue($ProcessId)
$assigned = 0
while ($pending.Count -gt 0) {
    $id = $pending.Dequeue()
    if ([BottlifyJob]::Assign($job, $id)) { $assigned++ }
    elseif ($id -eq $ProcessId) { throw "could not put process $ProcessId into the job" }
    $all | Where-Object { $_.ParentProcessId -eq $id } | ForEach-Object { $pending.Enqueue($_.ProcessId) }
}
"assigned $assigned"
