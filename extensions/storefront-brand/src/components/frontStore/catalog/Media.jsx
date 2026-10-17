// Derived from EverShop 2.2.1 Media (GPLv3); merchant component alias, no core patch.
// Preserve its named export, three size props, public context/Image and gallery contracts.
import React, { useEffect, useRef, useState } from 'react';
import Slider from 'react-slick';
import 'slick-carousel/slick/slick.css';
import { Image } from '@evershop/evershop/components/common/Image';
import { ProductNoThumbnail } from '@evershop/evershop/components/common/ProductNoThumbnail';
import { useCatalogImageDimensions } from '@evershop/evershop/components/common/useCatalogImageDimensions';
import { useProduct } from '@evershop/evershop/components/frontStore/catalog/ProductContext';
import { deriveProductImageSize } from '@evershop/evershop/lib/util/deriveProductImageSize';
import { _ } from '@evershop/evershop/lib/locale/translate/_';
import { AUTOPLAY_INTERVAL_MS, galleryImages, galleryIdentity, galleryPlaybackPolicy, watchGalleryEnvironment } from '../../../services/galleryAutoplay.js';
import './ProductGallery.scss';

const SlickSlider = Slider.default || Slider;

function GalleryArrow({ className = '', onClick, direction }) {
  return (
    <button type="button" className={`${className} custom-arrow ${direction}-arrow`} onClick={onClick}
      aria-label={_(direction === 'prev' ? 'Previous slide' : 'Next slide')}>
      <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d={direction === 'prev' ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6'} />
      </svg>
    </button>
  );
}

export function Media({ imageSize: imageSizeProp, thumbnailSize: thumbnailSizeProp, modalSize: modalSizeProp }) {
  const product = useProduct();
  const dimensions = useCatalogImageDimensions();
  const imageSize = imageSizeProp ?? deriveProductImageSize(1280, dimensions);
  const thumbnailSize = thumbnailSizeProp ?? deriveProductImageSize(200, dimensions);
  const modalSize = modalSizeProp ?? deriveProductImageSize(1920, dimensions);
  const images = galleryImages(product), identity = galleryIdentity(product, images);
  const mainSliderRef = useRef(null), modalSliderRef = useRef(null), stageRef = useRef(null);
  const dialogRef = useRef(null), closeRef = useRef(null), returnFocusRef = useRef(null), fullscreenRef = useRef(null);
  const lastReducedMotion = useRef(false);
  const [mounted, setMounted] = useState(false);
  const [environment, setEnvironment] = useState({ pageVisible: true, reducedMotion: false });
  const [manualPaused, setManualPaused] = useState(false);
  const [userRequestedPlay, setUserRequestedPlay] = useState(false);
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const [interacting, setInteracting] = useState(false);
  const [view, setView] = useState({ identity: '', index: 0 });
  const [modal, setModal] = useState(null), [isImageLoading, setIsImageLoading] = useState(false);
  const activeSlide = view.identity === identity ? Math.min(view.index, Math.max(0, images.length - 1)) : 0;
  const isModalOpen = modal?.identity === identity && images.length > 0;
  const policy = galleryPlaybackPolicy({ imageCount: images.length, mounted, manualPaused, userRequestedPlay,
    ...environment, hovered, focused, interacting, modalOpen: isModalOpen });

  useEffect(() => {
    setMounted(true);
    return watchGalleryEnvironment({ page: document,
      matchMedia: typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : null,
      onChange: next => {
        if (next.reducedMotion && !lastReducedMotion.current) setUserRequestedPlay(false);
        lastReducedMotion.current = next.reducedMotion;
        setEnvironment(next);
      } });
  }, []);

  // Remount only the Slick instance for a variant/gallery change. User pause intent
  // belongs to this Media and survives native AJAX variant updates.
  useEffect(() => {
    setModal(null); setIsImageLoading(false); setInteracting(false);
    setFocused(Boolean(stageRef.current?.contains(document.activeElement)));
  }, [identity]);

  useEffect(() => {
    const slider = mainSliderRef.current;
    // Slick's own paused state is sticky when only autoplay props change.
    if (policy.autoplay) slider?.slickPlay(); else slider?.slickPause();
    // Ref clears on unmount. Do not invoke a captured, already unmounted Slick
    // instance whose own inner ref has been released.
    return () => mainSliderRef.current?.slickPause();
  }, [policy.autoplay, identity]);

  useEffect(() => {
    if (!isModalOpen) return undefined;
    const body = document.body, oldOverflow = body.style.overflow;
    const previousFocus = returnFocusRef.current;
    body.style.overflow = 'hidden'; closeRef.current?.focus({ preventScroll: true });
    const handleKeyDown = event => {
      if (event.key === 'Escape') { event.preventDefault(); setModal(null); return; }
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        if (event.key === 'ArrowRight') modalSliderRef.current?.slickNext();
        else modalSliderRef.current?.slickPrev();
      }
      if (event.key === 'Tab') {
        const controls = [...(dialogRef.current?.querySelectorAll('button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])') || [])]
          .filter(control => !control.closest('[aria-hidden="true"]') && control.getClientRects().length > 0);
        const first = controls[0], last = controls.at(-1);
        if (first && event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (first && !event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      body.style.overflow = oldOverflow;
      const focusTarget = previousFocus?.isConnected && !previousFocus.closest('[aria-hidden="true"]')
        ? previousFocus : fullscreenRef.current;
      focusTarget?.focus({ preventScroll: true });
    };
  }, [isModalOpen, identity]);

  const openModal = (index, trigger) => {
    returnFocusRef.current = trigger || fullscreenRef.current;
    setView({ identity, index }); setIsImageLoading(false); setModal({ identity, index });
  };
  const togglePlayback = () => {
    if (policy.wantsPlayback) setManualPaused(true);
    else { setManualPaused(false); setUserRequestedPlay(true); }
  };
  const paging = index => (
    <button type="button" className="thumbnail-wrapper" aria-label={`${_('View image')} ${index + 1}`}>
      <Image src={images[index]?.url} alt={`Thumbnail ${index + 1}`} width={thumbnailSize.width} height={thumbnailSize.height}
        sizes="100px" objectFit="contain" />
    </button>
  );
  const sharedSettings = {
    dots: images.length > 1, dotsClass: 'slick-dots slick-thumb', infinite: images.length > 1,
    speed: policy.transitionSpeed, slidesToShow: 1, slidesToScroll: 1, arrows: images.length > 1,
    fade: false, accessibility: true, pauseOnHover: false, pauseOnFocus: false, pauseOnDotsHover: false,
    prevArrow: <GalleryArrow direction="prev" />, nextArrow: <GalleryArrow direction="next" />, customPaging: paging
  };

  return (
    <section className="product-media-container shusha-product-gallery" aria-label={_('Product images')}
      aria-roledescription="carousel" data-gallery-autoplay={policy.autoplay ? 'playing' : 'paused'}>
      {images.length > 0 && (
        <div className="shusha-gallery-controls">
          <span className="shusha-gallery-position" aria-live="off">{activeSlide + 1} / {images.length}</span>
          <div className="shusha-gallery-actions">
            <button type="button" className="shusha-gallery-open-fullscreen" ref={fullscreenRef}
              onClick={event => openModal(activeSlide, event.currentTarget)} aria-label={_('Open fullscreen view')} aria-haspopup="dialog">
              {_('View larger')}
            </button>
            {policy.canRotate && (
              <button type="button" className="shusha-gallery-autoplay" onClick={togglePlayback}
                aria-label={_(policy.wantsPlayback ? 'Pause slideshow' : 'Play slideshow')}>
                <span aria-hidden="true">{policy.wantsPlayback ? 'Ⅱ' : '▶'}</span>
                <span>{_(policy.wantsPlayback ? 'Pause slideshow' : 'Play slideshow')}</span>
              </button>
            )}
          </div>
        </div>
      )}
      <div className="shusha-gallery-stage" ref={stageRef}
        onPointerEnter={event => { if (event.pointerType === 'mouse' || event.pointerType === 'pen') setHovered(true); }}
        onPointerLeave={() => { setHovered(false); setInteracting(false); }}
        onPointerDown={event => { if (event.pointerType !== 'mouse') setInteracting(true); }}
        onPointerUp={() => setInteracting(false)} onPointerCancel={() => setInteracting(false)}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
        <div className="main-image-container">
          {images.length > 0 ? (
            <SlickSlider key={identity} ref={mainSliderRef} {...sharedSettings} className="product-slider"
              autoplay={policy.autoplay} autoplaySpeed={AUTOPLAY_INTERVAL_MS}
              beforeChange={(_, next) => setView({ identity, index: next })}>
              {images.map((image, index) => (
                <div key={image.url} className="product-image" onClick={() => openModal(index)}
                  style={{ width: '100%', aspectRatio: `${imageSize.width} / ${imageSize.height}` }}>
                  <Image src={image.url} alt={image.alt} width={imageSize.width} height={imageSize.height}
                    sizes="(max-width: 1024px) 100vw, 50vw" objectFit="scale-down" />
                </div>
              ))}
            </SlickSlider>
          ) : (
            <div className="w-full h-full flex items-center justify-center py-24 bg-muted">
              <ProductNoThumbnail className="w-48 h-48" />
            </div>
          )}
        </div>
      </div>
      {isModalOpen && (
        <div className="product-image-modal">
          <div className="modal-overlay" onClick={() => setModal(null)} aria-hidden="true" />
          <div className="modal-content" role="dialog" aria-modal="true" aria-label={`${product.name} — ${_('Product images')}`} ref={dialogRef}>
            <button type="button" className="modal-close" onClick={() => setModal(null)} ref={closeRef} aria-label={_('Close fullscreen view')}>
              <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
            <div className="modal-slider-container">
              {isImageLoading && <div className="loading-indicator" role="status">{_('Loading image')}</div>}
              <SlickSlider key={identity} ref={modalSliderRef} {...sharedSettings} autoplay={false} initialSlide={modal.index}
                adaptiveHeight lazyLoad="ondemand" swipe accessibility={false}
                beforeChange={() => setIsImageLoading(true)} afterChange={() => setIsImageLoading(false)}>
                {images.map(image => (
                  <div key={image.url} className="modal-image">
                    <Image src={image.url} alt={image.alt} width={modalSize.width * 1.5} height={modalSize.height * 1.5}
                      sizes="100vw" objectFit="contain" />
                  </div>
                ))}
              </SlickSlider>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
