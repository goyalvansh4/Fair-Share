const INTERNAL_BASE = 'https://fairshare.invalid';

export function getSafeInternalPath(destination: string | null): string {
  if (!destination) return '/';
  try {
    const url = new URL(destination, INTERNAL_BASE);
    if (url.origin !== INTERNAL_BASE || !url.pathname.startsWith('/')) return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}
