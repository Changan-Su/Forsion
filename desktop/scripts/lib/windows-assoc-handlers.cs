using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

// Read-only Shell discovery used by Open With, not a fabricated registry query.
// ABI/IIDs: microsoft/windows-rs 0.58.0 Win32/UI/Shell IAssocHandler and
// IEnumAssocHandlers; only their leading methods are called.
[ComImport, Guid("973810AE-9599-4B88-9E4D-6EE98C9552DA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ForsionEnumAssocHandlers {
    [PreserveSig] int Next(uint count, [MarshalAs(UnmanagedType.Interface)] out ForsionAssocHandler handler, out uint fetched);
}
[ComImport, Guid("F04061AC-1659-4A3F-A954-775AA57FC083"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ForsionAssocHandler {
    [PreserveSig] int GetName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    [PreserveSig] int GetUIName([MarshalAs(UnmanagedType.LPWStr)] out string name);
}
public class ForsionShellHandler {
    public string Name { get; set; }
    public string UIName { get; set; }
    public int NameResult { get; set; }
    public int UINameResult { get; set; }
}
public static class ForsionShellAssociations {
    [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
    static extern int SHAssocEnumHandlers(string extension, uint filter, out ForsionEnumAssocHandlers handlers);
    [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr reserved, uint flags);
    [DllImport("ole32.dll")] static extern void CoUninitialize();
    public static ForsionShellHandler[] Read(string extension) {
        int initialized = CoInitializeEx(IntPtr.Zero, 2);
        if (initialized < 0 && initialized != unchecked((int)0x80010106)) Marshal.ThrowExceptionForHR(initialized);
        ForsionEnumAssocHandlers enumerator = null;
        try {
            Marshal.ThrowExceptionForHR(SHAssocEnumHandlers(extension, 0, out enumerator));
            var result = new List<ForsionShellHandler>();
            for (int i=0; i<500; i++) {
                ForsionAssocHandler handler; uint fetched;
                int status = enumerator.Next(1, out handler, out fetched);
                Marshal.ThrowExceptionForHR(status);
                if (fetched == 0) return result.ToArray();
                if (handler == null) throw new InvalidOperationException("Shell returned a null handler");
                try {
                    string name, uiName;
                    int nameResult=handler.GetName(out name), uiResult=handler.GetUIName(out uiName);
                    result.Add(new ForsionShellHandler { Name=name, UIName=uiName, NameResult=nameResult, UINameResult=uiResult });
                } finally { Marshal.ReleaseComObject(handler); }
            }
            throw new InvalidOperationException("Shell handler enumeration exceeded its bound");
        } finally {
            if (enumerator != null) Marshal.ReleaseComObject(enumerator);
            if (initialized >= 0) CoUninitialize();
        }
    }
}
