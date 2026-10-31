// CrownSpawn - pomocnik startu gry CrownLaunchera (tylko Windows). Kompilowany przez launcher wbudowanym csc.exe
// (.NET Framework 4, C# 5 - bez nowszej składni), patrz src/main/core/native-spawn.js.
//
// Po co: Node nie pozwala ustawić praw dostępu do nowego procesu ani jego mitygacji, więc blokada wstrzykiwania kodu
// zakładana PO starcie (anticheat.hardenProcess) zostawiała ~0,5 s wyścigu. Tu proces gry powstaje już z:
//  - listą praw dostępu (DACL), która nikomu nie daje prawa do tworzenia wątków, zapisu pamięci, duplikowania uchwytów,
//    zawieszania ani zmiany tej listy (to samo, co hardenProcess, ale od pierwszej chwili),
//  - mitygacją „extension point disable”: system nie wstrzyknie do gry DLL przez globalne haki okien (SetWindowsHookEx),
//    AppInit_DLLs ani stare IME - to drogi, które nie potrzebują uchwytu do procesu,
//  - dziedziczeniem wyłącznie dwóch uchwytów (NUL jako wejście, rura wyjścia) - żaden inny uchwyt launchera nie wycieka.
//
// Protokół (tekst, UTF-8):
//  stdin  <- linie „exe|cwd|arg|env <base64(UTF-8)>”, potem „go”; później (opcjonalnie) „kill”
//  stdout -> surowe wyjście gry (stdout i stderr gry razem)
//  stderr -> linie sterujące: „PID <pid> guard=<0|1> ext=<0|1>”, „WARN <tekst>”, „ERR <kod> <tekst>” (przed PID-em: gra nie
//            wystartowała), „MOD+/MOD- <base64 ścieżki>” (biblioteki załadowane w grze), „EXIT <kod>”
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal static class CrownSpawn
{
    [StructLayout(LayoutKind.Sequential)]
    struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public int bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory,
        ref STARTUPINFOEX lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr Attribute, IntPtr lpValue,
        IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

    [DllImport("kernel32.dll")]
    static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, IntPtr lpPipeAttributes, uint nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes,
        uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessMitigationPolicy(IntPtr hProcess, int MitigationPolicy, IntPtr lpBuffer, IntPtr dwLength);

    [DllImport("psapi.dll", SetLastError = true)]
    static extern bool EnumProcessModulesEx(IntPtr hProcess, IntPtr lphModule, int cb, out int lpcbNeeded, uint dwFilterFlag);

    [DllImport("psapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern int GetModuleFileNameExW(IntPtr hProcess, IntPtr hModule, StringBuilder lpFilename, int nSize);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string StringSecurityDescriptor,
        uint StringSDRevision, out IntPtr SecurityDescriptor, out uint SecurityDescriptorSize);

    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const int STARTF_USESHOWWINDOW = 0x00000001;
    const int STARTF_USESTDHANDLES = 0x00000100;
    const uint HANDLE_FLAG_INHERIT = 0x00000001;
    const long MITIGATION_EXTENSION_POINT_DISABLE_ALWAYS_ON = 0x100000000L; // 1 << 32
    static readonly IntPtr ATTR_HANDLE_LIST = (IntPtr)0x00020002;
    static readonly IntPtr ATTR_MITIGATION_POLICY = (IntPtr)0x00020007;

    // Odmowa dla wszystkich: CREATE_THREAD | VM_OPERATION | VM_WRITE | DUP_HANDLE | CREATE_PROCESS | SUSPEND_RESUME | WRITE_DAC | WRITE_OWNER.
    // Ten sam opis co w anticheat.js (PROC_DENY_MASK) - zmieniasz tu, zmień tam.
    const string DENY_MASK = "0xc08ea";

    static StreamWriter ctl;
    static IntPtr hProcessGlobal = IntPtr.Zero;
    static volatile bool gameExited = false;

    static void Ctl(string line)
    {
        lock (ctl)
        {
            ctl.WriteLine(line);
        }
    }

    static string Clean(string s)
    {
        if (s == null) return "";
        s = s.Replace("\r", " ").Replace("\n", " ");
        return s.Length > 200 ? s.Substring(0, 200) : s;
    }

    static string Dec(string b64)
    {
        return Encoding.UTF8.GetString(Convert.FromBase64String(b64));
    }

    // Biblioteki załadowane w grze: pomocnik ma pełny uchwyt (z CreateProcess), więc widzi je mimo blokady dostępu, której
    // zwykłe narzędzia (tasklist, Toolhelp) nie przejdą. Zmiany idą do launchera jako „MOD+ / MOD- <base64 ścieżki>”.
    static void MonitorModules(IntPtr hProc)
    {
        HashSet<string> known = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        IntPtr[] mods = new IntPtr[2048];
        while (!gameExited)
        {
            try
            {
                int needed;
                GCHandle pin = GCHandle.Alloc(mods, GCHandleType.Pinned);
                bool ok;
                try
                {
                    ok = EnumProcessModulesEx(hProc, pin.AddrOfPinnedObject(), mods.Length * IntPtr.Size, out needed, 3);
                }
                finally
                {
                    pin.Free();
                }
                if (ok)
                {
                    int count = Math.Min(needed / IntPtr.Size, mods.Length);
                    HashSet<string> now = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    for (int i = 0; i < count; i++)
                    {
                        StringBuilder sb = new StringBuilder(1024);
                        if (GetModuleFileNameExW(hProc, mods[i], sb, sb.Capacity) > 0) now.Add(sb.ToString());
                    }
                    foreach (string p in now)
                        if (known.Add(p)) Ctl("MOD+ " + Convert.ToBase64String(Encoding.UTF8.GetBytes(p)));
                    List<string> gone = new List<string>();
                    foreach (string p in known)
                        if (!now.Contains(p)) gone.Add(p);
                    foreach (string p in gone)
                    {
                        known.Remove(p);
                        Ctl("MOD- " + Convert.ToBase64String(Encoding.UTF8.GetBytes(p)));
                    }
                }
            }
            catch (Exception)
            {
            }
            Thread.Sleep(500);
        }
    }

    static int Main(string[] argv)
    {
        ctl = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false));
        ctl.AutoFlush = true;
        ctl.NewLine = "\n";
        try
        {
            return Run();
        }
        catch (Exception e)
        {
            Ctl("ERR 0 " + Clean(e.GetType().Name + ": " + e.Message));
            return 1;
        }
    }

    // Standardowe cytowanie argumentów wiersza poleceń (CommandLineToArgvW / CRT) - jak w libuv i .NET.
    static void AppendArg(StringBuilder sb, string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            sb.Append(arg);
            return;
        }
        sb.Append('"');
        int bs = 0;
        foreach (char c in arg)
        {
            if (c == '\\')
            {
                bs++;
            }
            else if (c == '"')
            {
                sb.Append('\\', bs * 2 + 1);
                sb.Append('"');
                bs = 0;
            }
            else
            {
                if (bs > 0)
                {
                    sb.Append('\\', bs);
                    bs = 0;
                }
                sb.Append(c);
            }
        }
        if (bs > 0) sb.Append('\\', bs * 2);
        sb.Append('"');
    }

    static IntPtr BuildEnvBlock(List<string> env)
    {
        List<string> sorted = new List<string>(env);
        sorted.Sort(StringComparer.OrdinalIgnoreCase);
        StringBuilder sb = new StringBuilder();
        foreach (string e in sorted)
        {
            sb.Append(e);
            sb.Append('\0');
        }
        sb.Append('\0');
        return Marshal.StringToHGlobalUni(sb.ToString());
    }

    static IntPtr BuildSecurityAttributes(out string error)
    {
        error = null;
        string sid = System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
        string sddl = "D:P(D;;" + DENY_MASK + ";;;WD)(A;;RC;;;OW)(A;;0x1fffff;;;" + sid + ")(A;;0x1fffff;;;SY)(A;;0x1fffff;;;BA)";
        IntPtr sd;
        uint size;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, out size))
        {
            error = "sddl " + Marshal.GetLastWin32Error();
            return IntPtr.Zero;
        }
        SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
        sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        sa.lpSecurityDescriptor = sd;
        sa.bInheritHandle = 0;
        IntPtr p = Marshal.AllocHGlobal(sa.nLength);
        Marshal.StructureToPtr(sa, p, false);
        return p;
    }

    static bool TryCreate(string exe, StringBuilder cmd, IntPtr env, string cwd, IntPtr nul, IntPtr wr, IntPtr procAttrs,
        bool withPolicy, out PROCESS_INFORMATION pi, out int err)
    {
        int count = withPolicy ? 2 : 1;
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, count, 0, ref size); // zwraca false i podaje potrzebny rozmiar
        IntPtr attrs = Marshal.AllocHGlobal(size);
        pi = new PROCESS_INFORMATION();
        err = 0;
        try
        {
            if (!InitializeProcThreadAttributeList(attrs, count, 0, ref size))
            {
                err = Marshal.GetLastWin32Error();
                return false;
            }
            // dziedziczone są tylko te dwa uchwyty
            IntPtr hl = Marshal.AllocHGlobal(IntPtr.Size * 2);
            Marshal.WriteIntPtr(hl, 0, nul);
            Marshal.WriteIntPtr(hl, IntPtr.Size, wr);
            if (!UpdateProcThreadAttribute(attrs, 0, ATTR_HANDLE_LIST, hl, (IntPtr)(IntPtr.Size * 2), IntPtr.Zero, IntPtr.Zero))
            {
                err = Marshal.GetLastWin32Error();
                return false;
            }
            if (withPolicy)
            {
                IntPtr pol = Marshal.AllocHGlobal(8);
                Marshal.WriteInt64(pol, MITIGATION_EXTENSION_POINT_DISABLE_ALWAYS_ON);
                if (!UpdateProcThreadAttribute(attrs, 0, ATTR_MITIGATION_POLICY, pol, (IntPtr)8, IntPtr.Zero, IntPtr.Zero))
                {
                    err = Marshal.GetLastWin32Error();
                    return false;
                }
            }

            STARTUPINFOEX si = new STARTUPINFOEX();
            si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            si.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
            si.StartupInfo.wShowWindow = 0; // SW_HIDE - tak samo jak windowsHide w Node
            si.StartupInfo.hStdInput = nul;
            si.StartupInfo.hStdOutput = wr;
            si.StartupInfo.hStdError = wr;
            si.lpAttributeList = attrs;

            uint flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW;
            if (!CreateProcessW(exe, cmd, procAttrs, IntPtr.Zero, true, flags, env, cwd, ref si, out pi))
            {
                err = Marshal.GetLastWin32Error();
                return false;
            }
            return true;
        }
        finally
        {
            DeleteProcThreadAttributeList(attrs);
        }
    }

    static int Run()
    {
        string exe = null, cwd = null;
        List<string> args = new List<string>();
        List<string> env = new List<string>();
        StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        bool go = false;
        string line;
        while ((line = input.ReadLine()) != null)
        {
            if (line == "go")
            {
                go = true;
                break;
            }
            int sp = line.IndexOf(' ');
            if (sp < 0) continue;
            string key = line.Substring(0, sp);
            string val = Dec(line.Substring(sp + 1));
            if (key == "exe") exe = val;
            else if (key == "cwd") cwd = val;
            else if (key == "arg") args.Add(val);
            else if (key == "env") env.Add(val);
        }
        if (!go || exe == null)
        {
            Ctl("ERR 0 brak konfiguracji");
            return 2;
        }

        StringBuilder cmd = new StringBuilder();
        AppendArg(cmd, exe);
        foreach (string a in args)
        {
            cmd.Append(' ');
            AppendArg(cmd, a);
        }

        // rura wyjścia gry (koniec do zapisu dziedziczony przez grę) i NUL jako wejście
        SECURITY_ATTRIBUTES inh = new SECURITY_ATTRIBUTES();
        inh.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        inh.bInheritHandle = 1;
        IntPtr pInh = Marshal.AllocHGlobal(inh.nLength);
        Marshal.StructureToPtr(inh, pInh, false);
        IntPtr rd, wr;
        if (!CreatePipe(out rd, out wr, pInh, 0))
        {
            Ctl("ERR " + Marshal.GetLastWin32Error() + " pipe");
            return 3;
        }
        SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);
        IntPtr nul = CreateFileW("NUL", 0x80000000, 3, pInh, 3, 0, IntPtr.Zero);
        if (nul == (IntPtr)(-1))
        {
            Ctl("ERR " + Marshal.GetLastWin32Error() + " nul");
            return 3;
        }

        string secErr;
        IntPtr procAttrs = BuildSecurityAttributes(out secErr);
        if (procAttrs == IntPtr.Zero)
        {
            Ctl("ERR 0 " + secErr);
            return 3;
        }

        IntPtr envBlock = BuildEnvBlock(env);
        PROCESS_INFORMATION pi;
        int err;
        bool policy = true;
        if (!TryCreate(exe, cmd, envBlock, cwd, nul, wr, procAttrs, true, out pi, out err))
        {
            // starszy system bez tej mitygacji (87 = zły parametr): gra i tak dostaje blokadę dostępu
            if (err == 87)
            {
                policy = false;
                Ctl("WARN mitigation-unavailable");
                if (!TryCreate(exe, cmd, envBlock, cwd, nul, wr, procAttrs, false, out pi, out err))
                {
                    Ctl("ERR " + err + " CreateProcess");
                    return 4;
                }
            }
            else
            {
                Ctl("ERR " + err + " CreateProcess");
                return 4;
            }
        }
        hProcessGlobal = pi.hProcess;
        CloseHandle(pi.hThread);
        CloseHandle(wr); // koniec zapisu ma teraz tylko gra - EOF dopiero po jej zamknięciu
        CloseHandle(nul);

        // sprawdzenie: czy obcy proces (tu: my, ten sam użytkownik) NIE dostaje praw injectora do nowego procesu
        bool guard = false;
        IntPtr probe = OpenProcess(0x2 | 0x8 | 0x20 | 0x10 | 0x400, false, (uint)pi.dwProcessId);
        if (probe == IntPtr.Zero) guard = Marshal.GetLastWin32Error() == 5;
        else CloseHandle(probe);

        bool ext = false;
        if (policy)
        {
            try
            {
                IntPtr buf = Marshal.AllocHGlobal(4);
                Marshal.WriteInt32(buf, 0);
                if (GetProcessMitigationPolicy(pi.hProcess, 6, buf, (IntPtr)4)) ext = (Marshal.ReadInt32(buf) & 1) != 0;
            }
            catch (EntryPointNotFoundException)
            {
            }
        }
        Ctl("PID " + pi.dwProcessId + " guard=" + (guard ? 1 : 0) + " ext=" + (ext ? 1 : 0));

        // wyjście gry -> stdout (jeśli launcher przestanie czytać, nadal opróżniamy rurę, żeby gra się nie zablokowała)
        Thread reader = new Thread(delegate()
        {
            Stream so = Console.OpenStandardOutput();
            bool broken = false;
            try
            {
                FileStream fs = new FileStream(new SafeFileHandle(rd, true), FileAccess.Read, 4096, false);
                byte[] buf = new byte[16384];
                int n;
                while ((n = fs.Read(buf, 0, buf.Length)) > 0)
                {
                    if (broken) continue;
                    try
                    {
                        so.Write(buf, 0, n);
                        so.Flush();
                    }
                    catch (Exception)
                    {
                        broken = true;
                    }
                }
            }
            catch (Exception)
            {
            }
        });
        reader.IsBackground = true;
        reader.Start();

        // polecenie „kill” od launchera (uchwyt z CreateProcess ma pełne prawa, DACL go nie dotyczy)
        Thread killer = new Thread(delegate()
        {
            try
            {
                string l;
                while ((l = input.ReadLine()) != null)
                {
                    if (l == "kill") TerminateProcess(hProcessGlobal, 1);
                }
            }
            catch (Exception)
            {
            }
        });
        killer.IsBackground = true;
        killer.Start();

        IntPtr monitored = pi.hProcess;
        Thread monitor = new Thread(delegate() { MonitorModules(monitored); });
        monitor.IsBackground = true;
        monitor.Start();

        WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
        gameExited = true;
        uint code;
        if (!GetExitCodeProcess(pi.hProcess, out code)) code = 0xFFFFFFFF;
        reader.Join(3000); // wnuki gry mogą trzymać rurę otwartą - nie czekamy w nieskończoność
        Ctl("EXIT " + code);
        return 0;
    }
}
