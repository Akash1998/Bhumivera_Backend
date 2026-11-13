const parsePromoterProfileUrl = value => {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;

  const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  const segments = url.pathname.split('/').filter(Boolean);

  if (hostname === 'instagram.com') {
    const handle = segments[0];
    const reservedPaths = new Set(['accounts', 'about', 'developer', 'direct', 'explore', 'legal', 'p', 'privacy', 'reel', 'reels', 'stories']);
    if (!handle || reservedPaths.has(handle.toLowerCase()) || !/^[A-Za-z0-9._]{1,30}$/.test(handle)) return null;
    return { platform: 'Instagram', handle: `@${handle}` };
  }

  if (['youtube.com', 'm.youtube.com'].includes(hostname)) {
    if (segments[0]?.startsWith('@') && /^[A-Za-z0-9._-]{3,30}$/.test(segments[0].slice(1))) {
      return { platform: 'YouTube', handle: segments[0] };
    }
    if (['channel', 'user', 'c'].includes(segments[0]) && segments[1]) {
      return { platform: 'YouTube', handle: segments[1] };
    }
    return null;
  }

  if (['facebook.com', 'm.facebook.com'].includes(hostname)) {
    if (segments[0]?.toLowerCase() === 'profile.php') {
      const id = url.searchParams.get('id');
      return id && /^\d+$/.test(id) ? { platform: 'Facebook', handle: id } : null;
    }
    if (segments[0]?.toLowerCase() === 'pages' && /^\d+$/.test(segments[2] || '')) {
      return { platform: 'Facebook', handle: segments[2] };
    }
    const reservedPaths = new Set(['events', 'groups', 'marketplace', 'photo', 'photos', 'share', 'watch']);
    if (!segments[0] || reservedPaths.has(segments[0].toLowerCase())) return null;
    return { platform: 'Facebook', handle: segments[0] };
  }

  return null;
};

module.exports = { parsePromoterProfileUrl };
