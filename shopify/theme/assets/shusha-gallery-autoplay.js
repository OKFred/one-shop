/* SHUSHA extension for Dawn 16's native product gallery. No media/network writes. */
if (!customElements.get('shusha-gallery-autoplay')) {
  customElements.define('shusha-gallery-autoplay', class extends HTMLElement {
    connectedCallback() {
      if (this.cleanup) return;
      const gallery = this.closest('media-gallery[data-shusha-gallery-autoplay]');
      const viewer = gallery?.querySelector('[id^="GalleryViewer-"]');
      const list = viewer?.querySelector('[id^="Slider-Gallery-"]');
      const button = this.querySelector('button');
      if (!gallery || !viewer || !list || !button) return;

      const desktop = window.matchMedia('(min-width: 750px)');
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
      const stages = [viewer, gallery.querySelector('[id^="GalleryThumbnails-"]')].filter(Boolean);
      const modal = document.getElementById(gallery.id.replace('MediaGallery-', 'ProductModal-'));
      const removeListeners = [];
      let manualPaused = false;
      let userRequestedPlay = false;
      let lastReducedMotion = reducedMotion.matches;
      let hovered = false;
      let touching = false;
      let inView = true;
      let timer;
      let disposed = false;

      const listen = (target, event, handler) => {
        target.addEventListener(event, handler);
        removeListeners.push(() => target.removeEventListener(event, handler));
      };
      const watchQuery = (query, handler) => {
        if (query.addEventListener) listen(query, 'change', handler);
        else {
          query.addListener(handler);
          removeListeners.push(() => query.removeListener(handler));
        }
      };
      const items = () => Array.from(list.querySelectorAll(':scope > [data-media-id]'));
      const images = () => items().filter(item => item.querySelector('.product__modal-opener--image img'));
      const current = () => {
        const all = items();
        if (desktop.matches) return all.find(item => item.classList.contains('is-active')) || all[0];
        return all.reduce((nearest, item) => !nearest || Math.abs(item.offsetLeft - list.scrollLeft) <
          Math.abs(nearest.offsetLeft - list.scrollLeft) ? item : nearest, null);
      };
      const isImage = item => Boolean(item?.querySelector('.product__modal-opener--image img'));
      const wantsPlayback = () => !manualPaused && (!reducedMotion.matches || userRequestedPlay);
      const blocked = () => hovered || touching || !inView || document.hidden || modal?.hasAttribute('open') ||
        stages.some(stage => stage.contains(document.activeElement)) || !isImage(current());
      const clear = () => { window.clearTimeout(timer); timer = undefined; };

      const tick = () => {
        timer = undefined;
        if (disposed || !wantsPlayback() || blocked()) return synchronize();
        // Re-read after native variant reconciliation; never retain obsolete media nodes.
        const candidates = images();
        if (candidates.length < 2) return synchronize();
        const active = candidates[(candidates.indexOf(current()) + 1) % candidates.length];
        items().forEach(item => item.classList.toggle('is-active', item === active));
        list.scrollTo({ left: active.offsetLeft, behavior: reducedMotion.matches ? 'instant' : 'smooth' });
        const thumbnail = gallery.querySelector(`[data-target="${active.dataset.mediaId}"]`);
        // Native thumbnail bookkeeping only: setActiveMedia would scroll the whole page,
        // announce every automatic step and start video/model playback.
        if (thumbnail && typeof gallery.setActiveThumbnail === 'function') gallery.setActiveThumbnail(thumbnail);
        synchronize();
      };
      const synchronize = () => {
        if (disposed) return;
        clear();
        const available = images().length > 1;
        this.hidden = !available;
        const intent = wantsPlayback();
        const label = intent ? 'Pause slideshow' : 'Play slideshow';
        if (button.textContent.trim() !== label) button.textContent = label;
        button.setAttribute('aria-label', label);
        button.setAttribute('aria-pressed', String(intent));
        const playing = available && intent && !blocked();
        this.dataset.playing = String(playing);
        if (playing) timer = window.setTimeout(tick, 5000);
      };

      listen(button, 'click', () => {
        if (wantsPlayback()) manualPaused = true;
        else { manualPaused = false; userRequestedPlay = true; }
        synchronize();
      });
      stages.forEach(stage => {
        // Touch browsers may synthesize sticky mouseenter events after a tap.
        listen(stage, 'pointerenter', event => {
          if (event.pointerType === 'mouse' || event.pointerType === 'pen') hovered = true;
          synchronize();
        });
        listen(stage, 'pointerleave', () => { hovered = false; synchronize(); });
        listen(stage, 'focusin', synchronize);
        // focusout fires before the browser installs the next activeElement.
        listen(stage, 'focusout', () => queueMicrotask(synchronize));
        listen(stage, 'pointerdown', event => { if (event.pointerType === 'touch') touching = true; synchronize(); });
      });
      listen(document, 'pointerup', () => { touching = false; synchronize(); });
      listen(document, 'pointercancel', () => { touching = false; synchronize(); });
      listen(document, 'visibilitychange', synchronize);
      listen(viewer, 'slideChanged', synchronize);
      listen(gallery, 'click', event => { if (!this.contains(event.target)) synchronize(); });
      watchQuery(desktop, synchronize);
      watchQuery(reducedMotion, () => {
        if (reducedMotion.matches && !lastReducedMotion) userRequestedPlay = false;
        lastReducedMotion = reducedMotion.matches;
        synchronize();
      });

      const mediaObserver = new MutationObserver(synchronize);
      mediaObserver.observe(list, { childList: true });
      const modalObserver = modal ? new MutationObserver(synchronize) : null;
      modalObserver?.observe(modal, { attributes: true, attributeFilter: ['open'] });
      const visibilityObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
        inView = entries[0]?.isIntersecting !== false;
        synchronize();
      }) : null;
      visibilityObserver?.observe(viewer);
      this.cleanup = () => {
        disposed = true;
        clear();
        removeListeners.forEach(remove => remove());
        mediaObserver.disconnect();
        modalObserver?.disconnect();
        visibilityObserver?.disconnect();
        this.hidden = true;
      };
      synchronize();
    }

    disconnectedCallback() {
      this.cleanup?.();
      this.cleanup = null;
    }
  });
}
