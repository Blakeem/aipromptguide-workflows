# Moves one file or directory to the Recycle Bin through IFileOperation, or refuses with every file left in place.
# A helper killed mid-move can leave a partial state, which trash.mjs reports as unknown.
# Run by tools/trash.mjs, which verifies the result on disk. Input: $env:AIPG_TRASH_TARGET, absolute and resolved,
# with no \\?\ prefix. Output: one JSON line on stdout. Exit: 0 the shell recycled the item as one item and reported
# its Recycle Bin path, 1 an empty target or a helper that failed to load, 2 otherwise.
# ASCII only, since Windows PowerShell 5.1 reads a file without a BOM in the ANSI code page.
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace AipgTrash
{
    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellItem
    {
        void BindToHandler();
        void GetParent();
        [PreserveSig] int GetDisplayName(uint sigdn, out IntPtr name);
    }

    [ComImport, Guid("04b0f1a7-9490-44bc-96e1-4296a31252e2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IFileOperationProgressSink
    {
        [PreserveSig] int StartOperations();
        [PreserveSig] int FinishOperations(int hr);
        [PreserveSig] int PreRenameItem(uint flags, IntPtr item, IntPtr newName);
        [PreserveSig] int PostRenameItem(uint flags, IntPtr item, IntPtr newName, int hr, IntPtr created);
        [PreserveSig] int PreMoveItem(uint flags, IntPtr item, IntPtr dest, IntPtr newName);
        [PreserveSig] int PostMoveItem(uint flags, IntPtr item, IntPtr dest, IntPtr newName, int hr, IntPtr created);
        [PreserveSig] int PreCopyItem(uint flags, IntPtr item, IntPtr dest, IntPtr newName);
        [PreserveSig] int PostCopyItem(uint flags, IntPtr item, IntPtr dest, IntPtr newName, int hr, IntPtr created);
        [PreserveSig] int PreDeleteItem(uint flags, IShellItem item);
        [PreserveSig] int PostDeleteItem(uint flags, IShellItem item, int hr, IShellItem created);
        [PreserveSig] int PreNewItem(uint flags, IntPtr dest, IntPtr newName);
        [PreserveSig] int PostNewItem(uint flags, IntPtr dest, IntPtr newName, IntPtr template, uint attributes, int hr, IntPtr created);
        [PreserveSig] int UpdateProgress(uint total, uint done);
        [PreserveSig] int ResetTimer();
        [PreserveSig] int PauseTimer();
        [PreserveSig] int ResumeTimer();
    }

    [ComImport, Guid("947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IFileOperation
    {
        [PreserveSig] int Advise(IFileOperationProgressSink sink, out uint cookie);
        [PreserveSig] int Unadvise(uint cookie);
        [PreserveSig] int SetOperationFlags(uint flags);
        void SetProgressMessage(); void SetProgressDialog(); void SetProperties(); void SetOwnerWindow();
        void ApplyPropertiesToItem(); void ApplyPropertiesToItems(); void RenameItem(); void RenameItems();
        void MoveItem(); void MoveItems(); void CopyItem(); void CopyItems();
        [PreserveSig] int DeleteItem(IShellItem item, IFileOperationProgressSink sink);
        void DeleteItems(); void NewItem();
        [PreserveSig] int PerformOperations();
        [PreserveSig] int GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
    }

    [ComVisible(true)]
    public sealed class StrictSink : IFileOperationProgressSink
    {
        const uint TSF_DELETE_RECYCLE_IF_POSSIBLE = 0x80;
        const int E_ABORT = unchecked((int)0x80004004);
        public int PreDeleteCalls;
        public string Veto;
        public int? DeleteHr;
        public string RecycledPath;

        public int PreDeleteItem(uint flags, IShellItem item)
        {
            PreDeleteCalls++;
            // A recycled item moves as one rename. A second call is a per-item fallback or an extra item,
            // either of which can delete permanently or leave a partial result.
            if (PreDeleteCalls > 1) { Veto = "a second item or a per-item fallback"; return E_ABORT; }
            if ((flags & TSF_DELETE_RECYCLE_IF_POSSIBLE) == 0) { Veto = "no recycling possible (the shell would delete permanently)"; return E_ABORT; }
            return 0;
        }

        public int PostDeleteItem(uint flags, IShellItem item, int hr, IShellItem created)
        {
            if (PreDeleteCalls == 1) { DeleteHr = hr; RecycledPath = Native.PathOf(created); }
            return 0;
        }

        public int StartOperations() { return 0; }
        public int FinishOperations(int hr) { return 0; }
        public int PreRenameItem(uint f, IntPtr i, IntPtr n) { return 0; }
        public int PostRenameItem(uint f, IntPtr i, IntPtr n, int hr, IntPtr c) { return 0; }
        public int PreMoveItem(uint f, IntPtr i, IntPtr d, IntPtr n) { return 0; }
        public int PostMoveItem(uint f, IntPtr i, IntPtr d, IntPtr n, int hr, IntPtr c) { return 0; }
        public int PreCopyItem(uint f, IntPtr i, IntPtr d, IntPtr n) { return 0; }
        public int PostCopyItem(uint f, IntPtr i, IntPtr d, IntPtr n, int hr, IntPtr c) { return 0; }
        public int PreNewItem(uint f, IntPtr d, IntPtr n) { return 0; }
        public int PostNewItem(uint f, IntPtr d, IntPtr n, IntPtr t, uint a, int hr, IntPtr c) { return 0; }
        public int UpdateProgress(uint total, uint done) { return 0; }
        public int ResetTimer() { return 0; }
        public int PauseTimer() { return 0; }
        public int ResumeTimer() { return 0; }
    }

    public static class Native
    {
        const uint SIGDN_FILESYSPATH = 0x80058000;
        const string LONG_PREFIX = @"\\?\";
        const string LONG_UNC_PREFIX = @"\\?\UNC\";
        const int MAX_LONG_PATH = 32768;

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        public static extern int SHCreateItemFromParsingName(string path, IntPtr bindContext, ref Guid iid, out IShellItem item);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        static extern uint GetLongPathNameW(string shortPath, StringBuilder longPath, uint size);

        public static string PathOf(IShellItem item)
        {
            IntPtr name;
            string path;
            if (item == null || item.GetDisplayName(SIGDN_FILESYSPATH, out name) != 0) return null;
            path = Marshal.PtrToStringUni(name);
            Marshal.FreeCoTaskMem(name);
            return path;
        }

        // The \\?\ form lets the expansion pass MAX_PATH whatever the host's long-path setting.
        public static string LongPathOf(string path)
        {
            StringBuilder buffer = new StringBuilder(MAX_LONG_PATH);
            string prefixed;
            string expanded;
            uint length;
            if (path == null) return null;
            prefixed = path.StartsWith(@"\\", StringComparison.Ordinal) ? LONG_UNC_PREFIX + path.Substring(2) : LONG_PREFIX + path;
            length = GetLongPathNameW(prefixed, buffer, MAX_LONG_PATH);
            if (length == 0 || length >= MAX_LONG_PATH) return null;
            expanded = buffer.ToString();
            return expanded.StartsWith(LONG_UNC_PREFIX, StringComparison.Ordinal) ? @"\\" + expanded.Substring(LONG_UNC_PREFIX.Length) : expanded.Substring(LONG_PREFIX.Length);
        }
    }

    public sealed class Outcome
    {
        public bool Success;
        public string Target;
        public string RecycledPath;
        public string Veto;
        public string CreateHr;
        public string PerformHr;
        public string DeleteHr;
        public bool Aborted;
        public int PreDeleteCalls;
        public string Error;
    }

    public static class Recycler
    {
        // FOF_NO_UI | FOF_ALLOWUNDO | FOF_NO_CONNECTED_ELEMENTS | FOFX_RECYCLEONDELETE | FOFX_EARLYFAILURE.
        // FOF_WANTNUKEWARNING opens a modal dialog that ignores FOF_NO_UI, and FOFX_SHOWELEVATIONPROMPT is UI.
        const uint Flags = 0x0614 | 0x0040 | 0x2000 | 0x00080000 | 0x00100000;

        public static Outcome Run(string target)
        {
            Outcome outcome = null;
            Exception failure = null;
            // IFileOperation requires a single-threaded apartment, whatever apartment the host thread uses.
            Thread worker = new Thread(delegate () { try { outcome = RunOnSta(target); } catch (Exception e) { failure = e; } });
            worker.SetApartmentState(ApartmentState.STA);
            worker.Start();
            worker.Join();
            if (failure != null) { outcome = new Outcome(); outcome.Target = target; outcome.Error = failure.GetType().FullName + ": " + failure.Message; }
            outcome.Success = outcome.Error == null && outcome.Veto == null && !outcome.Aborted && outcome.PreDeleteCalls == 1
                && outcome.RecycledPath != null && IsSuccess(outcome.PerformHr) && IsSuccess(outcome.DeleteHr);
            return outcome;
        }

        static Outcome RunOnSta(string target)
        {
            Outcome outcome = new Outcome();
            StrictSink sink = new StrictSink();
            Guid iidShellItem = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
            IFileOperation operation = null;
            IShellItem item = null;
            string parsed = null;
            string parsedLong = null;
            bool aborted = false;
            uint cookie = 0;
            int hr;
            outcome.Target = target;
            try
            {
                hr = Native.SHCreateItemFromParsingName(target, IntPtr.Zero, ref iidShellItem, out item);
                outcome.CreateHr = Hex(hr);
                if (hr != 0) { outcome.Error = "SHCreateItemFromParsingName " + Hex(hr); return outcome; }
                // The parser applies Win32 normalization, such as stripping a trailing dot or space, so it can name another item.
                // A long-path-aware host reports a path of MAX_PATH or more in its 8.3 form, so the long form is compared too.
                parsed = Native.PathOf(item);
                parsedLong = Native.LongPathOf(parsed);
                if (!string.Equals(parsed, target, StringComparison.OrdinalIgnoreCase) && !string.Equals(parsedLong, target, StringComparison.OrdinalIgnoreCase))
                {
                    outcome.Error = "the shell parses the path as " + (parsedLong ?? parsed ?? "an item with no file-system path");
                    return outcome;
                }
                operation = (IFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("3ad05575-8857-4850-9277-11b85bdb8e09")));
                hr = operation.SetOperationFlags(Flags);
                if (hr != 0) { outcome.Error = "SetOperationFlags " + Hex(hr); return outcome; }
                // An operation-wide sink sees every item the shell touches. A per-item sink misses connected elements.
                hr = operation.Advise(sink, out cookie);
                if (hr != 0) { outcome.Error = "Advise " + Hex(hr); return outcome; }
                hr = operation.DeleteItem(item, null);
                if (hr != 0) { outcome.Error = "DeleteItem " + Hex(hr); return outcome; }
                outcome.PerformHr = Hex(operation.PerformOperations());
                hr = operation.GetAnyOperationsAborted(out aborted);
                if (hr != 0) outcome.Error = "GetAnyOperationsAborted " + Hex(hr);
                outcome.Aborted = aborted;
            }
            finally
            {
                if (operation != null && cookie != 0) operation.Unadvise(cookie);
                if (item != null) Marshal.ReleaseComObject(item);
                if (operation != null) Marshal.ReleaseComObject(operation);
            }
            outcome.Veto = sink.Veto;
            outcome.PreDeleteCalls = sink.PreDeleteCalls;
            outcome.DeleteHr = sink.DeleteHr.HasValue ? Hex(sink.DeleteHr.Value) : null;
            outcome.RecycledPath = sink.RecycledPath;
            return outcome;
        }

        static bool IsSuccess(string hr) { return hr != null && Convert.ToInt32(hr, 16) >= 0; }

        static string Hex(int value) { return "0x" + value.ToString("X8"); }
    }
}
'@

# Raw UTF-8 bytes, because the console encoding of a redirected stdout differs between hosts and mangles non-ASCII paths.
function Write-Outcome($outcome) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($outcome | ConvertTo-Json -Compress) + "`n")
    $stdout = [Console]::OpenStandardOutput()
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}

$target = $env:AIPG_TRASH_TARGET
if ([string]::IsNullOrEmpty($target)) { Write-Outcome @{ Success = $false; Error = 'AIPG_TRASH_TARGET is empty' }; exit 1 }
try {
    Add-Type -TypeDefinition $source
    $outcome = [AipgTrash.Recycler]::Run($target)
} catch {
    Write-Outcome @{ Success = $false; Target = $target; Error = $_.Exception.GetType().FullName + ': ' + $_.Exception.Message }
    exit 1
}
Write-Outcome $outcome
if ($outcome.Success) { exit 0 }
exit 2
