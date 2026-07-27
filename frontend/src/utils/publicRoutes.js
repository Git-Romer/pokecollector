export const isPublicSharePath = (pathname = '') =>
  pathname === '/u' || pathname.startsWith('/u/')
