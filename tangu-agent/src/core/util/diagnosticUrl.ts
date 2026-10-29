/** Diagnostic URLs are display-only. Never fall back to the raw value after parse failure. */
export function redactDiagnosticUrl(raw: string | undefined): string {
  if (!raw) return '';
  // Keep ordinary SQLite filenames (including Windows drive paths) useful for diagnosis.
  if (!raw.includes('://') && !/[?@#=]/.test(raw) && (/^(?:[A-Za-z]:[\\/]|[./\\])/.test(raw) || /^[\w .-]+\.(?:db|sqlite|sqlite3)$/.test(raw) || raw === ':memory:')) return raw;
  try {
    const url = new URL(raw);
    if (!url.host && !['file:', 'sqlite:'].includes(url.protocol)) return '[redacted invalid URL]';
    if (url.username) url.username = 'redacted';
    if (url.password) url.password = 'redacted';
    for (const key of [...url.searchParams.keys()]) {
      let decoded = key;
      for (let i = 0; i < 3; i++) { try { decoded = decodeURIComponent(decoded); } catch { break; } }
      if (/token|key|pass|secret|auth|credential|signature|sig$|code/i.test(decoded)) url.searchParams.set(key, 'redacted');
    }
    // Fragments may carry OAuth tokens and do not help connectivity diagnostics.
    if (url.hash) url.hash = 'redacted';
    return url.href;
  } catch {
    return '[redacted invalid URL]';
  }
}
