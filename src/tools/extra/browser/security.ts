export function isUrlAllowed(rawUrl: string, allowPatterns: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  // Only http and https protocols are supported
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();

  return allowPatterns.some((pattern) => {
    const pat = pattern.trim().toLowerCase();
    if (pat === hostname) {
      return true;
    }
    // Handle wildcard host patterns like *.local or *.example.com
    if (pat.startsWith('*.')) {
      const suffix = pat.slice(1); // e.g. .local or .example.com
      return hostname.endsWith(suffix);
    }
    return false;
  });
}
