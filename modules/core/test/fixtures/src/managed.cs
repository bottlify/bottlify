// Copyright © 2026 Bottlify Project
// Licensed under the Mozilla Public License, version 2.0
// See LICENSE for details

// A .NET 4 console program run under the bottle's Mono: output, an exception
// thrown and caught (the runtime's own fault handling over Win32), a thread
// joined, generics, floating point, the collector, and the command line. It
// exits with 0 only when everything came out right.
//
// Built with Mono's C# compiler: mcs -sdk:4.5 -out:managed.exe managed.cs

using System;
using System.Collections.Generic;
using System.Threading;

class Managed
{
    static int Divide(int a, int b) { return a / b; }

    static int Main(string[] args)
    {
        int failures = 0;
        Console.WriteLine("managed: started with " + args.Length + " arguments");

        try { Divide(1, args.Length - args.Length); failures++; }
        catch (DivideByZeroException) { Console.WriteLine("managed: caught division by zero"); }

        try { object o = null; o.GetHashCode(); failures++; }
        catch (NullReferenceException) { Console.WriteLine("managed: caught null reference"); }

        int fromThread = 0;
        var thread = new Thread(()=>{ for (int i = 1; i <= 100; i++) fromThread += i; });
        thread.Start();
        thread.Join();
        if (fromThread != 5050) failures++;
        Console.WriteLine("managed: thread summed " + fromThread);

        var list = new List<int> { 5, 3, 9, 1, 7 };
        list.Sort();
        if (string.Join(",", list) != "1,3,5,7,9") failures++;

        double root = Math.Sqrt(2.0);
        string text = root.ToString("F6", System.Globalization.CultureInfo.InvariantCulture);
        if (text != "1.414214") failures++;
        Console.WriteLine("managed: sqrt(2) = " + text);

        var garbage = new List<byte[]>();
        for (int i = 0; i < 200; i++) garbage.Add(new byte[64 * 1024]);
        garbage = null;
        GC.Collect();
        GC.WaitForPendingFinalizers();

        if (args.Length != 2 || args[0] != "one" || args[1] != "two words") failures++;
        Console.WriteLine("managed: " + (failures == 0 ? "ok" : failures + " failures"));
        return failures;
    }
}
