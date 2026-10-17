export const AUTOPLAY_INTERVAL_MS = 5000;

export function galleryImages(product = {}) {
  const seen = new Set();
  return [product.image, ...(Array.isArray(product.gallery) ? product.gallery : [])].flatMap(image => {
    const url = typeof image?.url === 'string' ? image.url.trim() : '';
    if (!url || url.startsWith('#') || /[\u0000-\u001f\u007f]/.test(url) || seen.has(url)) return [];
    let parsed;
    try { parsed = new URL(url, 'https://shusha.invalid/'); } catch (_) { return []; }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return [];
    seen.add(url);
    return [{ url, alt: typeof image.alt === 'string' && image.alt.trim() ? image.alt : product.name || 'Product image' }];
  });
}

export function galleryIdentity(product = {}, images = galleryImages(product)) {
  return JSON.stringify([product.uuid || product.sku || '', images.map(image => image.url)]);
}

export function galleryPlaybackPolicy({ imageCount = 0, mounted = false, manualPaused = false,
  userRequestedPlay = false, reducedMotion = false, hovered = false, focused = false,
  modalOpen = false, pageVisible = true, interacting = false } = {}) {
  const canRotate = Number.isSafeInteger(imageCount) && imageCount >= 2;
  const wantsPlayback = canRotate && !manualPaused && (!reducedMotion || userRequestedPlay);
  return {
    canRotate,
    wantsPlayback,
    autoplay: Boolean(mounted && wantsPlayback && pageVisible && !hovered && !focused && !modalOpen && !interacting),
    transitionSpeed: reducedMotion ? 0 : 500
  };
}

// Inject browser surfaces so listener ownership/cleanup can be verified without a DOM.
// This is called only after React mounts; importing/rendering the component is SSR-safe.
export function watchGalleryEnvironment({ page, matchMedia, onChange }) {
  const motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let stopped = false;
  const update = () => {
    if (!stopped) onChange({
      pageVisible: !page || typeof page.visibilityState !== 'string' || page.visibilityState === 'visible',
      reducedMotion: Boolean(motion?.matches)
    });
  };
  page?.addEventListener?.('visibilitychange', update);
  const modernMotion = typeof motion?.addEventListener === 'function';
  if (modernMotion) motion.addEventListener('change', update);
  else motion?.addListener?.(update);
  update();
  return () => {
    if (stopped) return;
    stopped = true;
    page?.removeEventListener?.('visibilitychange', update);
    if (modernMotion) motion.removeEventListener?.('change', update);
    else motion?.removeListener?.(update);
  };
}
