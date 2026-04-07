import { useState, useEffect, useMemo, useRef, type KeyboardEvent, type ReactElement } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowLeft, ArrowRight, Bookmark as BookmarkIcon, Trash2, X, List, Highlighter, Search, Settings } from 'lucide-react';
import ePub, { Rendition, Book as EpubBook } from 'epubjs';
import { db, type Book, type Highlight, type Bookmark } from '../lib/db';
import { cn } from '../lib/utils';

interface ReaderProps {
  book: Book;
  onClose: () => void;
}

type ActiveTab = 'toc' | 'highlights' | 'search' | 'settings';

type PageTransition = 'slide' | 'fastfade' | 'curl';
type NavigationDirection = 'next' | 'prev';

type TransitionVisualState = {
  mode: PageTransition;
  dir: NavigationDirection;
  token: number;
};

type SearchResult = {
  cfi: string;
  excerpt: string;
  sectionIndex: number;
};

type SearchSessionState = {
  query: string;
  results: SearchResult[];
  hasTriggeredSearch: boolean;
};

type TocItem = {
  id?: string;
  href?: string;
  label?: string;
  subitems?: TocItem[];
};

const TONE_COLORS = {
  light: { bg: '#FAF7F2', color: '#1C1C1E' },
  sepia: { bg: '#F4ECD8', color: '#433422' },
  dark: { bg: '#111214', color: '#F4F1E8' }
};

export default function Reader({ book, onClose }: ReaderProps) {
  const [rendition, setRendition] = useState<Rendition | null>(null);
  const [epub, setEpub] = useState<EpubBook | null>(null);
  const [showControls, setShowControls] = useState(true);
  const [activeTab, setActiveTab] = useState<ActiveTab | null>(null);
  const [showQuickActions, setShowQuickActions] = useState(false);
  const [progress, setProgress] = useState(0);
  const [location, setLocation] = useState<string | null>(book.lastLocation);
  const [currentPage, setCurrentPage] = useState(1);
  const [locationsReady, setLocationsReady] = useState(false);
  const controlsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchHoldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTouchHold = useRef(false);
  const preventNextClick = useRef(false);

  // Highlights
  const [highlights, setHighlights] = useState<Highlight[]>(book.highlights || []);
  const [selectedText, setSelectedText] = useState<{ text: string, cfiRange: string } | null>(null);
  const [selectionPosition, setSelectionPosition] = useState<{ x: number, y: number } | null>(null);
  const [highlightToErase, setHighlightToErase] = useState<{ cfiRange: string, position: { x: number, y: number } } | null>(null);
  // Pending highlight (two-step: pick colour → add note → save)
  const [pendingHighlight, setPendingHighlight] = useState<{ text: string; cfiRange: string; color: string } | null>(null);
  const [pendingNote, setPendingNote] = useState('');

  // TOC
  const [toc, setToc] = useState<TocItem[]>([]);
  const [totalPages, setTotalPages] = useState<number | null>(null);

  // Bookmarks
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(() => {
    if (book.bookmarks?.length) return book.bookmarks;
    // Migrate legacy single bookmark
    const old = book.bookmark as any;
    if (old?.cfi) return [{ cfi: old.cfi, addedAt: Date.now() }];
    return [];
  });
  const [annotationsTab, setAnnotationsTab] = useState<'bookmarks' | 'highlights'>('highlights');
  const [pageTone, setPageTone] = useState<'light' | 'sepia' | 'dark'>(() => {
    try {
      const saved = localStorage.getItem('gugu-reader-theme');
      if (saved === 'light' || saved === 'sepia' || saved === 'dark') return saved;
    } catch {/* storage unavailable */}
    return 'light';
  });

  // Page transitions — default is Fade; user preference overrides via localStorage
  const [pageTransition, setPageTransition] = useState<PageTransition>(() => {
    try {
      const saved = localStorage.getItem('gugu-reader-page-turn');
      if (saved === 'slide' || saved === 'fastfade' || saved === 'curl') return saved;
    } catch {/* storage unavailable */}
    return 'fastfade';
  });
  const [showPageIndicator, setShowPageIndicator] = useState(false);
  const [transitionVisual, setTransitionVisual] = useState<TransitionVisualState | null>(null);
  const pageIndicatorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isNavigatingRef = useRef(false);
  const lastNavTime = useRef(0);
  const sectionPageTotalsRef = useRef<number[]>([]);
  const sectionOffsetsRef = useRef<number[]>([]);
  const paginationRecalcTokenRef = useRef(0);
  const maxTotalPagesRef = useRef(0);

  // Search
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isSearching, setIsSearching] = useState(false);
  const [lastSearchedQuery, setLastSearchedQuery] = useState<string>('');
  const [hasTriggeredSearch, setHasTriggeredSearch] = useState(false);

  const viewerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const edgeGestureStart = useRef<{ x: number; y: number; nearEdge: boolean } | null>(null);
  const searchHighlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSearchHighlightCfi = useRef<string | null>(null);
  // Stores the epubjs CFI produced by the 'selected' event so the mouseup/touchend
  // handlers (injected into each iframe) can pick it up without a stale closure.
  const pendingSelectionCfiRef = useRef<string | null>(null);
  const noteTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Ref always mirrors pageTone so callbacks captured in closures (rendered, hooks.content)
  // always read the live theme value instead of the stale value from mount time.
  const pageToneRef = useRef<'light' | 'sepia' | 'dark'>(pageTone);

  const getSearchSessionKey = () => (book.id ? `gugu-reader-search-${book.id}` : null);
  const getAnnotationsTabSessionKey = () => (book.id ? `gugu-reader-annotations-tab-${book.id}` : null);
  const isPanelInteractionActive = !!activeTab || showQuickActions;
  const isPanelVisible = showControls || isPanelInteractionActive;
  const showPaginationDebug = Boolean((import.meta as any).env?.DEV);

  const paginationDebug = useMemo(() => {
    const locationsApi = epub?.locations as any;
    if (!location) return null;
    if (typeof locationsApi?.length !== 'function' || typeof locationsApi?.locationFromCfi !== 'function') {
      return null;
    }

    const total = locationsApi.length();
    const index = locationsApi.locationFromCfi(location);

    let sectionIndex: number | null = null;
    try {
      const section = (epub?.spine as any)?.get(location);
      sectionIndex = typeof section?.index === 'number' ? section.index : null;
    } catch {
      sectionIndex = null;
    }

    return {
      total: typeof total === 'number' && Number.isFinite(total) ? total : 0,
      index: typeof index === 'number' && Number.isFinite(index) ? Math.floor(index) : -1,
      sectionIndex,
    };
  }, [epub, location]);

  // Derived state for bookmark
  const isBookmarked = !!location && bookmarks.some((b) => b.cfi === location);

  const getBookmarkLocationIndex = (cfi: string) => {
    const locationsApi = (epub?.locations as any);
    if (typeof locationsApi?.locationFromCfi !== 'function') return Number.POSITIVE_INFINITY;
    const index = locationsApi.locationFromCfi(cfi);
    return typeof index === 'number' && Number.isFinite(index) ? index : Number.POSITIVE_INFINITY;
  };

  const sortedBookmarks = useMemo(() => {
    return [...bookmarks].sort((a, b) => {
      const ai = getBookmarkLocationIndex(a.cfi);
      const bi = getBookmarkLocationIndex(b.cfi);

      if (!Number.isFinite(ai) && !Number.isFinite(bi)) {
        return a.addedAt - b.addedAt;
      }

      if (!Number.isFinite(ai)) return 1;
      if (!Number.isFinite(bi)) return -1;
      return ai - bi;
    });
  }, [bookmarks, epub, locationsReady]);

  const getToneColor = (tone: typeof pageTone) => TONE_COLORS[tone];

  const openAnnotationsPanel = (preferredTab?: 'bookmarks' | 'highlights') => {
    if (preferredTab) {
      setAnnotationsTab(preferredTab);
    }
    openPanel('highlights');
  };

  const normalizeHref = (href: string): string => {
    if (!href) return '';
    return href.split('?')[0].split('#')[0].split('/').pop() || '';
  };

  const currentSectionFile = useMemo(() => {
    if (!epub || !location) return '';
    try {
      const section = (epub.spine as any).get(location);
      const sectionHref = (section?.canonical || section?.url || section?.href || '') as string;
      return normalizeHref(sectionHref);
    } catch {
      return '';
    }
  }, [epub, location]);

  const isTocItemActive = (item: TocItem): boolean => {
    const file = normalizeHref(item.href || '');
    if (file && currentSectionFile && file === currentSectionFile) return true;
    if (Array.isArray(item.subitems) && item.subitems.length > 0) {
      return item.subitems.some(isTocItemActive);
    }
    return false;
  };

  const applyStyles = (r: Rendition, tone: 'light' | 'sepia' | 'dark') => {
    const currentTone = TONE_COLORS[tone];

    r.themes.default({
      'html': {
        'margin': '0 !important',
        'padding': '0 !important',
      },
      'body': {
        // Do NOT set padding here — epub.js columns() sets its own padding that the
        // SVG highlight overlay (marks-pane) is calibrated against. Overriding it
        // causes highlights to drift away from the actual text.
        'max-width': '100% !important',
        'overflow-x': 'hidden !important',
        'color': `${currentTone.color} !important`,
        'font-family': '"Libre Baskerville", Georgia, serif !important',
        'line-height': '1.6 !important',
        'font-size': '100% !important',
        'word-wrap': 'break-word !important',
        'overflow-wrap': 'break-word !important',
        'white-space': 'normal !important',
        'background-color': `${currentTone.bg} !important`,
        'margin': '0 !important',
        'box-sizing': 'border-box !important',
      },
      'img': {
        'max-width': '100% !important',
        'height': 'auto !important'
      },
      'pre': {
        'max-width': '100% !important',
        'height': 'auto !important'
      },
      'body, body *': {
        'max-width': '100% !important',
        'box-sizing': 'border-box !important',
        '-webkit-touch-callout': 'none !important',
      },
      '::selection': {
        'background': 'rgba(0, 122, 255, 0.3) !important', // Make selection visible instead of transparent
      },
    });
    
    // Also update the viewer container background
    if (viewerRef.current) {
      viewerRef.current.style.backgroundColor = currentTone.bg;
    }
  };

  useEffect(() => {
    // Keep history in sync so back always closes reader first
    const hasHistoryState = { current: false } as { current: boolean };
    const closingViaBack = { current: false } as { current: boolean };

    window.history.pushState({ reader: true }, '');
    hasHistoryState.current = true;

    const handlePopState = (e: PopStateEvent) => {
      closingViaBack.current = true;
      onClose();
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
      if (hasHistoryState.current && !closingViaBack.current) {
        window.history.back();
      }
    };
  }, [onClose]);

  useEffect(() => {
    // Fetch latest highlights and bookmark from DB to ensure freshness
    if (book.id) {
      db.books.get(book.id).then(latestBook => {
        if (latestBook) {
          if (latestBook.highlights) setHighlights(latestBook.highlights);
          if (latestBook.lastLocation) setLocation(latestBook.lastLocation);
          if (latestBook.bookmarks?.length) {
            setBookmarks(latestBook.bookmarks);
          } else {
            const old = (latestBook.bookmark as any);
            if (old?.cfi) setBookmarks([{ cfi: old.cfi, addedAt: Date.now() }]);
          }
        }
      });
    }
  }, [book.id]);

  useEffect(() => {
    if (!viewerRef.current) return;

    const waitForPaint = async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
    };

    const sum = (nums: number[]) => nums.reduce((acc, n) => acc + n, 0);

    const buildOffsets = (totals: number[]) => {
      const offsets: number[] = new Array(totals.length).fill(0);
      let acc = 0;
      for (let i = 0; i < totals.length; i++) {
        offsets[i] = acc;
        acc += totals[i] || 0;
      }
      return offsets;
    };

    const epubInstance = ePub(book.data);
    setEpub(epubInstance);

    const containerWidth = viewerRef.current.clientWidth;
    const containerHeight = viewerRef.current.clientHeight;

    const renditionOptions: any = {
      width: containerWidth,
      height: containerHeight,
      manager: 'default',
      flow: 'paginated',
      spread: 'none',
      method: 'blobUrl',
      allowScriptedContent: false,
    };

    const renditionInstance = epubInstance.renderTo(viewerRef.current, renditionOptions);

    setRendition(renditionInstance);

    let isMounted = true;
    const locationsApi = epubInstance.locations as any;
    let locationsPreloaded = false;
    let preloadedTotal = 0;

    const getMetricsFromCfi = (cfi: string) => {
      if (!cfi) return null;
      if (typeof locationsApi?.length !== 'function' || typeof locationsApi?.locationFromCfi !== 'function') {
        return null;
      }

      const total = locationsApi.length();
      if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) {
        return null;
      }

      const index = locationsApi.locationFromCfi(cfi);
      if (typeof index !== 'number' || !Number.isFinite(index) || index < 0) {
        return null;
      }

      const current = Math.max(1, Math.min(total, Math.floor(index) + 1));
      return {
        total,
        current,
        progress: current / total,
      };
    };

    const calculateDynamicPageMetrics = (loc: any) => {
      const cfi = loc?.start?.cfi;
      const cfiMetrics = typeof cfi === 'string' ? getMetricsFromCfi(cfi) : null;
      if (cfiMetrics) {
        return {
          cfi,
          total: cfiMetrics.total,
          current: cfiMetrics.current,
          progress: cfiMetrics.progress,
        };
      }

      const sectionIndex = typeof loc?.start?.index === 'number' ? loc.start.index : -1;
      const localPage = typeof loc?.start?.displayed?.page === 'number' ? loc.start.displayed.page : 1;
      const localTotal = typeof loc?.start?.displayed?.total === 'number' ? loc.start.displayed.total : 0;

      const offsets = sectionOffsetsRef.current;
      const totals = sectionPageTotalsRef.current;
      const mappedCurrent = sectionIndex >= 0 && sectionIndex < offsets.length
        ? offsets[sectionIndex] + Math.max(1, localPage)
        : Math.max(1, localPage);

      const mappedTotal = totals.length > 0 ? sum(totals) : localTotal > 0 ? localTotal : null;

      const current = mappedTotal ? Math.min(mappedTotal, mappedCurrent) : mappedCurrent;
      const pct = typeof loc?.start?.percentage === 'number'
        ? loc.start.percentage
        : mappedTotal && mappedTotal > 0
        ? current / mappedTotal
        : 0;

      return {
        cfi,
        total: mappedTotal,
        current,
        progress: Math.max(0, Math.min(1, pct)),
      };
    };

    // safeSetTotalPages ensures the displayed total never decreases during a session.
    // This prevents the "Page 1 of 20 → Page 1 of 47" flicker caused by the three
    // async phases each calling setTotalPages with a different intermediate value.
    const safeSetTotalPages = (n: number | null) => {
      if (n === null || !Number.isFinite(n) || n <= 0) return;
      if (n >= maxTotalPagesRef.current) {
        maxTotalPagesRef.current = n;
        setTotalPages(n);
      }
    };

    const syncPaginationFromLocation = (loc: any) => {
      const metrics = calculateDynamicPageMetrics(loc);
      if (!metrics.cfi) return;

      setLocation(metrics.cfi);
      setProgress(metrics.progress);
      setCurrentPage(metrics.current);
      if (metrics.total !== null) safeSetTotalPages(metrics.total);
      setLocationsReady(maxTotalPagesRef.current > 0);
      updateProgressInDb(metrics.progress, metrics.cfi);
    };

    const handleRegionTap = (x: number) => {
      // Use viewer container width for safe, scale-independent zone calculation
      const width = viewerRef.current?.clientWidth || window.innerWidth;
      // 20% left, 60% center, 20% right distribution
      const leftMax = width * 0.2;
      const rightMin = width * 0.8;

      if (x < leftMax) {
        prev().catch(console.error);
        return;
      }

      if (x >= rightMin) {
        next().catch(console.error);
        return;
      }

      setShowControls((current) => {
        if (!current) {
          flashPageIndicator();
          setTimeout(() => setShowControls(true), 20);
        }
        return !current;
      });

      setActiveTab(null);
      setSelectedText(null);
      setHighlightToErase(null);
      setPendingHighlight(null);
      setPendingNote('');
    };

    // Pre-load cached locations before first render so the relocated event already
    // has the full CFI array and can show the correct "Page X of Y" immediately.
    if (book.cachedLocations && typeof locationsApi?.load === 'function') {
      try {
        locationsApi.load(book.cachedLocations);
        preloadedTotal = typeof locationsApi.length === 'function' ? locationsApi.length() : 0;
        if (preloadedTotal > 0) {
          locationsPreloaded = true;
          // Use the more accurate layout total if available (avoids the CFI-based count
          // being overridden later when recalcLayoutPaginationInBackground resolves).
          const initialTotal = (book.cachedLayoutTotal && book.cachedLayoutTotal > preloadedTotal)
            ? book.cachedLayoutTotal
            : preloadedTotal;
          maxTotalPagesRef.current = initialTotal;
          setTotalPages(initialTotal);
          setLocationsReady(true);
        }
      } catch (err) {
        console.warn('[reader-pagination] locations:preload-failed', err);
      }
    }

    const generateAndCacheLocations = async () => {
      try {
        // Only reset locationsReady if we have nothing to show yet
        if (maxTotalPagesRef.current <= 0) {
          setLocationsReady(false);
        }
        // Always generate at baseline stride so the cache is font-agnostic
        await locationsApi.generate(1024);
      } catch (err) {
        console.warn('[reader-pagination] locations:generate-failed', err);
        return;
      }

      if (!isMounted) return;

      const generatedTotal = typeof locationsApi.length === 'function' ? locationsApi.length() : 0;

      // Persist baseline for instant load next time
      if (book.id && generatedTotal > 0 && typeof locationsApi.save === 'function') {
        try {
          const serialized: string = locationsApi.save();
          if (serialized) {
            db.books.update(book.id, { cachedLocations: serialized }).catch(() => {});
          }
        } catch {/* noop */}
      }

      const currentLoc = renditionInstance.currentLocation?.();
      if (currentLoc) {
        syncPaginationFromLocation(currentLoc);
      } else {
        if (generatedTotal > 0) {
          safeSetTotalPages(generatedTotal);
          setLocationsReady(true);
        }
      }
    };

    const recalcLayoutPaginationInBackground = async () => {
      if (!viewerRef.current) return;

      const token = ++paginationRecalcTokenRef.current;
      const tempContainer = document.createElement('div');
      tempContainer.style.position = 'fixed';
      tempContainer.style.left = '-100000px';
      tempContainer.style.top = '0';
      tempContainer.style.width = `${viewerRef.current.clientWidth}px`;
      tempContainer.style.height = `${viewerRef.current.clientHeight}px`;
      tempContainer.style.opacity = '0';
      tempContainer.style.pointerEvents = 'none';
      document.body.appendChild(tempContainer);

      const tempBook = ePub(book.data);
      const tempRendition = tempBook.renderTo(tempContainer, {
        width: viewerRef.current.clientWidth,
        height: viewerRef.current.clientHeight,
        manager: 'default',
        flow: 'paginated',
        spread: 'none',
        method: 'blobUrl',
        allowScriptedContent: false,
      } as any);

      try {
        await tempBook.ready;
        applyStyles(tempRendition, pageTone);

        const spine = tempBook.spine as any;
        const spineItems = Array.isArray(spine?.spineItems)
          ? spine.spineItems
          : Array.isArray(spine?.items)
          ? spine.items
          : [];

        if (spineItems.length === 0) {
          return;
        }

        const totals: number[] = [];
        for (let i = 0; i < spineItems.length; i++) {
          if (!isMounted || paginationRecalcTokenRef.current !== token) return;
          try {
            await tempRendition.display(i);
            await waitForPaint();
            const loc = tempRendition.currentLocation?.() as any;
            const localTotal = typeof loc?.start?.displayed?.total === 'number' ? loc.start.displayed.total : 0;
            totals[i] = localTotal > 0 ? localTotal : 1;
          } catch {
            totals[i] = 1;
          }
        }

        if (!isMounted || paginationRecalcTokenRef.current !== token) return;

        sectionPageTotalsRef.current = totals;
        sectionOffsetsRef.current = buildOffsets(totals);
        const renderedTotal = sum(totals);
        if (renderedTotal > 0) {
          safeSetTotalPages(renderedTotal);
          setLocationsReady(true);
          // Persist the layout total so next open is instant
          if (book.id) {
            db.books.update(book.id, { cachedLayoutTotal: renderedTotal }).catch(() => {});
          }
          const currentLoc = renditionInstance.currentLocation?.();
          if (currentLoc) {
            syncPaginationFromLocation(currentLoc);
          }
        }
      } catch (err) {
        console.warn('[reader-pagination] layout:recalc-failed', err);
      } finally {
        try {
          tempBook.destroy();
        } catch {}
        try {
          tempContainer.remove();
        } catch {}
      }
    };

    const handleResize = () => {
      if (viewerRef.current && renditionInstance) {
        renditionInstance.resize(viewerRef.current.clientWidth, viewerRef.current.clientHeight);
        // relocated event fires after resize and re-syncs pagination automatically
      }
    };
    window.addEventListener('resize', handleResize);

    const displayPromise = location 
      ? renditionInstance.display(location) 
      : renditionInstance.display();

    displayPromise.catch(console.error);

    renditionInstance.on('rendered', () => {
      if (isMounted) {
        // Use pageToneRef.current – NOT the closed-over pageTone state variable –
        // so this always applies the live theme even after the user has changed it.
        applyStyles(renditionInstance, pageToneRef.current);
      }
    });

    // Inject theme colours directly into each iframe's body as soon as its content
    // is created. This avoids a white/default flash before themes.default() CSS loads
    // and ensures the colour is right even before the rendered event fires.
    renditionInstance.hooks.content.register((contents: any) => {
      const body = contents.document.body;
      const html = contents.document.documentElement;
      const tone = TONE_COLORS[pageToneRef.current];

      if (html) {
        html.style.backgroundColor = tone.bg;
      }

      if (body) {
        // Do NOT override margin/padding — epub.js columns() sets these for
        // proper SVG highlight overlay alignment.
        body.style.width = '100%';
        body.style.boxSizing = 'border-box';
        body.style.webkitTouchCallout = 'none'; // Suppress mobile callout menu
        body.style.backgroundColor = tone.bg;
        body.style.color = tone.color;
      }

      // Suppress native context menu
      contents.document.addEventListener('contextmenu', (e: Event) => {
        e.preventDefault();
      });

      // ── Native Tap & Selection Handling ─────────────────────────────────────
      // We handle touches and clicks natively on the iframe document to bypass 
      // epub.js's flaky event wrapping which loses coordinates on mobile and
      // conflicts with text selection.

      let touchStartX = 0;
      let touchStartY = 0;
      let touchStartTime = 0;
      let selectionActive = false;
      let lastSelectionClearTime = 0;
      let lastTapTime = 0;

      const isHighlightClick = (el: any) => el && typeof el.closest === 'function' && el.closest('.hl-class');

      const captureSelection = () => {
        const sel = contents.window?.getSelection?.();
        if (!sel || sel.rangeCount === 0 || !sel.toString().trim()) return;

        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (!rect || (rect.width === 0 && rect.height === 0)) return;

        const text = sel.toString().trim();
        const cfi = pendingSelectionCfiRef.current;
        if (!cfi || !text) return;

        // Convert iframe-local coords to page coords
        const iframeEl = contents.document.defaultView?.frameElement as HTMLElement | null;
        const iframeRect = iframeEl?.getBoundingClientRect() ?? { left: 0, top: 0 };
        const x = iframeRect.left + rect.left + rect.width / 2;
        const y = iframeRect.top + rect.top;

        setPendingHighlight(null);
        setPendingNote('');
        setSelectedText({ text, cfiRange: cfi });
        setSelectionPosition({ x, y });
        pendingSelectionCfiRef.current = null;
        
        // We do NOT clear the native selection here so it is visibly retained!
      };
      
      // Pass a reference of captureSelection to the rendition instance so the 'selected' event can invoke it
      (renditionInstance as any)._captureSelection = captureSelection;

      contents.document.addEventListener('touchstart', (e: TouchEvent) => {
        if (e.touches.length > 0) {
          // Reverted to clientX: screenX conflicted with devicePixelRatio hardware scaling
          touchStartX = e.touches[0].clientX;
          touchStartY = e.touches[0].clientY;
          touchStartTime = Date.now();
        }
      }, { passive: true });

      contents.document.addEventListener('touchend', (e: TouchEvent) => {
        if (e.changedTouches.length === 0) return;
        const touch = e.changedTouches[0];
        
        const dx = Math.abs(touch.clientX - touchStartX);
        const dy = Math.abs(touch.clientY - touchStartY);
        const dt = Date.now() - touchStartTime;

        // Detect horizontal swipe gesture (fast, mostly horizontal, > 40px)
        if (dx > 40 && dx > dy * 1.5 && dt < 400) {
          if (isHighlightClick(e.target)) return;
          
          setTimeout(() => {
             const sel = contents.window?.getSelection?.();
             // Only execute swipe if it didn't result in a text selection
             if (!sel || sel.isCollapsed || sel.toString().trim().length === 0) {
                 if (touch.clientX < touchStartX) {
                     next().catch(console.error); // Swipe left -> Next page
                 } else {
                     prev().catch(console.error); // Swipe right -> Previous page
                 }
             } else {
                 captureSelection();
             }
          }, 60);
          return;
        }

        // Tap gestures: Relaxed tolerance up to 30px to account for fat fingers
        // slipping on the glass, especially near screen edges.
        if (dx < 30 && dy < 30 && dt < 400) {
          if (isHighlightClick(e.target)) return;
          
          lastTapTime = Date.now(); // Register tap immediately to block synthetic clicks
          
          setTimeout(() => {
            if (Date.now() - lastSelectionClearTime < 300) return; // Tap was used to dismiss selection
            const sel = contents.window?.getSelection?.();
            if (!sel || sel.isCollapsed || sel.toString().trim().length === 0) {
               if (!selectionActive) {
                  // Forward inner logical clientX
                  handleRegionTap(touch.clientX);
               }
            } else {
               captureSelection(); // Trigger capture if tap resulted in selection (e.g. double tap)
            }
          }, 60);
        } else {
           // It was a non-swipe drag/long-press. Check if it created a selection.
           setTimeout(captureSelection, 120);
        }
      });

      contents.document.addEventListener('click', (e: MouseEvent) => {
        if (Date.now() - lastTapTime < 500) return; // Already handled by touch
        if (isHighlightClick(e.target)) return;

        const sel = contents.window?.getSelection?.();
        if (!sel || sel.isCollapsed || sel.toString().trim().length === 0) {
          if (!selectionActive && Date.now() - lastSelectionClearTime >= 300) {
             lastTapTime = Date.now();
             handleRegionTap(e.clientX);
          }
        }
      });

      contents.document.addEventListener('mouseup', () => {
         // Fallback for desktop selection
         setTimeout(captureSelection, 80);
      });

      contents.document.addEventListener('selectionchange', () => {
         const sel = contents.window?.getSelection?.();
         if (!sel || sel.isCollapsed || sel.toString().trim().length === 0) {
            if (selectionActive) {
                selectionActive = false;
                lastSelectionClearTime = Date.now();
                // Schedule clear to avoid react state updates during event rendering locks
                setTimeout(() => {
                    setSelectedText(null);
                    setPendingHighlight(null);
                    setPendingNote('');
                    setHighlightToErase(null);
                }, 0);
            }
         } else {
            selectionActive = true;
         }
      });
    });

    renditionInstance.on('relocated', (loc: any) => {
      if (!isMounted) return;
      syncPaginationFromLocation(loc);
    });

    let selectionTimeout: any = null;
    renditionInstance.on('selected', (cfiRange: string) => {
      pendingSelectionCfiRef.current = cfiRange;
      if (typeof (renditionInstance as any)._captureSelection === 'function') {
         if (selectionTimeout) clearTimeout(selectionTimeout);
         // Defers the popup by 300ms so if the user is extending the selection bounds
         // using Android text handles, it always locks onto the FINAL selection CFI!
         selectionTimeout = setTimeout(() => (renditionInstance as any)._captureSelection(), 300);
      }
    });

    epubInstance.ready.then(async () => {
      if (!isMounted) return Promise.reject('unmounted');

      try {
        const navigation = await (epubInstance.loaded as any).navigation;
        if (isMounted) {
          setToc((navigation?.toc || []) as TocItem[]);
        }
      } catch (err) {
        console.warn('[reader-toc] navigation:load-failed', err);
        if (isMounted) setToc([]);
      }

      const spine = epubInstance.spine as any;
      const spineItems = Array.isArray(spine?.spineItems)
        ? spine.spineItems
        : Array.isArray(spine?.items)
        ? spine.items
        : [];
      const isSuspiciousCachedTotal = locationsPreloaded && preloadedTotal <= 1 && spineItems.length > 3;

      if (isSuspiciousCachedTotal) {
        console.warn('[reader-pagination] locations:suspicious-cache-regenerate', {
          preloadedTotal,
          spineItems: spineItems.length,
        });
        await generateAndCacheLocations();
      } else if (locationsPreloaded) {
        // Locations already loaded from cache — just make sure current page is synced
        const currentLoc = renditionInstance.currentLocation?.();
        if (currentLoc) syncPaginationFromLocation(currentLoc);
      } else {
        // First open: generate full location list and cache it
        await generateAndCacheLocations();
      }

      // Skip the expensive layout recalc if we already have a warm cached total
      // AND a preloaded CFI list — the number won't be meaningfully different.
      const hasBothCaches = locationsPreloaded && (book.cachedLayoutTotal ?? 0) > 0;
      if (!hasBothCaches) {
        recalcLayoutPaginationInBackground().catch((err) => {
          console.warn('[reader-pagination] layout:background-recalc-failed', err);
        });
      }

      flashPageIndicator();
    }).catch((err) => {
      if (err !== 'unmounted') console.error(err);
    });

    return () => {
      window.removeEventListener('resize', handleResize);
      isMounted = false;
      paginationRecalcTokenRef.current += 1;
      if (searchHighlightTimer.current) {
        clearTimeout(searchHighlightTimer.current);
        searchHighlightTimer.current = null;
      }
      epubInstance.destroy();
    };
  }, [book.id]);

  useEffect(() => {
    if (isPanelInteractionActive) {
      clearControlsTimer();
      return;
    }

    if (showControls) {
      startControlsAutoHide();
    } else {
      clearControlsTimer();
    }

    return () => {
      clearControlsTimer();
    };
  }, [showControls, isPanelInteractionActive]);

  useEffect(() => {
    const key = getSearchSessionKey();
    if (!key) return;

    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return;
      const parsed = JSON.parse(raw) as SearchSessionState;

      if (typeof parsed.query === 'string') {
        setSearchQuery(parsed.query);
      }

      if (Array.isArray(parsed.results)) {
        setSearchResults(parsed.results);
      }

      setHasTriggeredSearch(Boolean(parsed.hasTriggeredSearch));
      if (parsed.query?.trim()) {
        setLastSearchedQuery(parsed.query.trim());
      }
    } catch (err) {
      console.warn('[reader-search] state:restore-failed', err);
    }
  }, [book.id]);

  useEffect(() => {
    const key = getAnnotationsTabSessionKey();
    if (!key) return;

    try {
      const saved = sessionStorage.getItem(key);
      if (saved === 'bookmarks' || saved === 'highlights') {
        setAnnotationsTab(saved);
      }
    } catch (err) {
      console.warn('[reader-annotations] tab:restore-failed', err);
    }
  }, [book.id]);

  useEffect(() => {
    const key = getSearchSessionKey();
    if (!key) return;

    try {
      const shouldClear = !searchQuery.trim() && searchResults.length === 0 && !hasTriggeredSearch;
      if (shouldClear) {
        sessionStorage.removeItem(key);
        return;
      }

      const payload: SearchSessionState = {
        query: searchQuery,
        results: searchResults,
        hasTriggeredSearch,
      };

      sessionStorage.setItem(key, JSON.stringify(payload));
    } catch (err) {
      console.warn('[reader-search] state:persist-failed', err);
    }
  }, [book.id, searchQuery, searchResults, hasTriggeredSearch]);

  useEffect(() => {
    const key = getAnnotationsTabSessionKey();
    if (!key) return;

    try {
      sessionStorage.setItem(key, annotationsTab);
    } catch (err) {
      console.warn('[reader-annotations] tab:persist-failed', err);
    }
  }, [book.id, annotationsTab]);

  // Keep pageToneRef in sync and persist the user's choice.
  // Also re-apply styles to the active rendition so already-open iframes update immediately.
  useEffect(() => {
    pageToneRef.current = pageTone;
    try { localStorage.setItem('gugu-reader-theme', pageTone); } catch {/* noop */}
    if (rendition) {
      applyStyles(rendition, pageTone);
      // Force re-apply to any currently-loaded iframes via getContents
      try {
        const tone = TONE_COLORS[pageTone];
        const contents = (rendition as any).getContents?.();
        const contentList = Array.isArray(contents) ? contents : contents ? [contents] : [];
        contentList.forEach((c: any) => {
          const html = c?.document?.documentElement;
          const body = c?.document?.body;
          if (html) html.style.backgroundColor = tone.bg;
          if (body) {
            body.style.backgroundColor = tone.bg;
            body.style.color = tone.color;
          }
        });
      } catch {/* noop — rendition may not have content yet */}
    }
  }, [pageTone, rendition]);

  // Persist page-turn preference so it survives reopening the book.
  useEffect(() => {
    try { localStorage.setItem('gugu-reader-page-turn', pageTransition); } catch {/* noop */}
  }, [pageTransition]);



  const updateProgressInDb = async (p: number, loc: string) => {
    if (book.id) {
      await db.books.update(book.id, {
        progress: p,
        lastLocation: loc
      });
    }
  };

  const confirmHighlight = async (note?: string) => {
    if (!pendingHighlight || !rendition || !book.id) return;

    const newHighlight: Highlight = {
      cfiRange: pendingHighlight.cfiRange,
      text: pendingHighlight.text,
      color: pendingHighlight.color,
      addedAt: Date.now(),
      ...(note?.trim() ? { note: note.trim() } : {}),
    };

    const updatedHighlights = [...highlights, newHighlight];
    setHighlights(updatedHighlights);

    rendition.annotations.add(
      'highlight',
      pendingHighlight.cfiRange,
      {},
      (e: any) => {
        const rect = e.target.getBoundingClientRect();
        setHighlightToErase({
          cfiRange: pendingHighlight.cfiRange,
          position: { x: rect.left + rect.width / 2, y: rect.top },
        });
      },
      'hl-class',
      { fill: pendingHighlight.color, "fill-opacity": "0.3", "mix-blend-mode": "multiply" }
    );

    await db.books.update(book.id, { highlights: updatedHighlights });

    setPendingHighlight(null);
    setPendingNote('');
    setSelectedText(null);
    setSelectionPosition(null);
  };

  const removeHighlight = async (cfiRange: string) => {
    if (!rendition || !book.id) return;

    const updatedHighlights = highlights.filter(h => h.cfiRange !== cfiRange);
    setHighlights(updatedHighlights);

    rendition.annotations.remove(cfiRange, 'highlight');

    await db.books.update(book.id, { highlights: updatedHighlights });
    setSelectedText(null);
    setSelectionPosition(null);
    setHighlightToErase(null);
    setPendingHighlight(null);
    setPendingNote('');
  };

  const toggleBookmark = async () => {
    if (!book.id) return;

    const currentLoc = rendition?.currentLocation?.() as any;
    const currentCfi = currentLoc?.start?.cfi || location;
    if (!currentCfi) return;

    if (bookmarks.some((b) => b.cfi === currentCfi)) {
      const updated = bookmarks.filter((b) => b.cfi !== currentCfi);
      setBookmarks(updated);
      await db.books.update(book.id, { bookmarks: updated });
    } else {
      const sectionIndex = typeof currentLoc?.start?.index === 'number' ? currentLoc.start.index : undefined;
      const pageInSection = typeof currentLoc?.start?.displayed?.page === 'number' ? currentLoc.start.displayed.page : undefined;
      const newBookmark: Bookmark = { cfi: currentCfi, addedAt: Date.now(), sectionIndex, pageInSection };
      const updated = [...bookmarks, newBookmark];
      setBookmarks(updated);
      await db.books.update(book.id, { bookmarks: updated });
    }
  };

  const waitForBookmarkPaint = async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
  };

  const navigateToBookmark = async (bm: Bookmark) => {
    if (!rendition) return;

    try {
      await rendition.display(bm.cfi);
      await waitForBookmarkPaint();

      // Fine-tune within the same section so returning to bookmark matches visual page.
      if (typeof bm.sectionIndex !== 'number' || typeof bm.pageInSection !== 'number') {
        return;
      }

      let currentLoc = rendition.currentLocation?.() as any;
      let currentSection = currentLoc?.start?.index;
      let currentPageInSection = currentLoc?.start?.displayed?.page;

      if (currentSection !== bm.sectionIndex || typeof currentPageInSection !== 'number') {
        return;
      }

      let delta = bm.pageInSection - currentPageInSection;
      if (delta === 0 || Math.abs(delta) > 4) {
        return;
      }

      while (delta !== 0) {
        if (delta > 0) {
          await rendition.next();
          delta -= 1;
        } else {
          await rendition.prev();
          delta += 1;
        }
        await waitForBookmarkPaint();

        currentLoc = rendition.currentLocation?.() as any;
        currentSection = currentLoc?.start?.index;
        if (currentSection !== bm.sectionIndex) {
          break;
        }
      }
    } catch (err) {
      console.warn('[reader-bookmark] navigate-failed', err);
    }
  };

  const deleteBookmark = async (cfi: string) => {
    if (!book.id) return;
    const updated = bookmarks.filter(b => b.cfi !== cfi);
    setBookmarks(updated);
    await db.books.update(book.id, { bookmarks: updated });
  };

  const resolveChapterTitle = (cfi: string): string => {
    if (!epub || !toc.length) return '';
    try {
      const section = (epub.spine as any).get(cfi);
      if (!section) return '';
      const sectionHref = (section.canonical || section.url || section.href || '') as string;
      const sectionFile = normalizeHref(sectionHref);
      const matchToc = (items: TocItem[]): string => {
        for (const item of items) {
          const itemFile = normalizeHref(item.href || '');
          if (itemFile && itemFile === sectionFile) return item.label?.trim() || '';
          if (Array.isArray(item.subitems) && item.subitems.length) {
            const sub = matchToc(item.subitems);
            if (sub) return sub;
          }
        }
        return '';
      };
      return matchToc(toc);
    } catch {
      return '';
    }
  };

  const flashPageIndicator = () => {
    setShowPageIndicator(true);
    if (pageIndicatorTimer.current) clearTimeout(pageIndicatorTimer.current);
    pageIndicatorTimer.current = setTimeout(() => setShowPageIndicator(false), 1800);
  };

  const clearControlsTimer = () => {
    if (controlsTimer.current) {
      clearTimeout(controlsTimer.current);
      controlsTimer.current = null;
    }
  };

  const startControlsAutoHide = () => {
    clearControlsTimer();
    controlsTimer.current = setTimeout(() => {
      setShowControls(false);
      setActiveTab(null);
      setShowQuickActions(false);
    }, 3600);
  };

  const toggleControls = () => {
    setActiveTab(null);
    setShowQuickActions(false);
    setSelectedText(null);
    setHighlightToErase(null);
    setPendingHighlight(null);
    setPendingNote('');

    if (!showControls) {
      flashPageIndicator();
      setTimeout(() => setShowControls(true), 20);
    } else {
      setShowControls(false);
    }
  };

  const openPanel = (tab: ActiveTab) => {
    setShowControls(true);
    setShowQuickActions(false);
    setActiveTab(tab);
  };

  const closePanel = () => {
    setActiveTab(null);
    setShowQuickActions(false);
  };

  const handleSearch = async () => {
    const query = searchQuery.trim();
    if (!query || !epub) {
      setSearchResults([]);
      setHasTriggeredSearch(false);
      setLastSearchedQuery('');
      return;
    }

    if (isSearching) {
      return;
    }

    if (query === lastSearchedQuery && searchResults.length > 0) {
      return;
    }

    setHasTriggeredSearch(true);
    setIsSearching(true);
    const results: SearchResult[] = [];

    console.log('[reader-search] search:start', {
      query,
      currentLocation: location,
    });

    try {
      const spine = epub.spine as any;
      const spineItems = Array.isArray(spine.spineItems)
        ? spine.spineItems
        : Array.isArray(spine.items)
        ? spine.items
        : [];

      for (let i = 0; i < spineItems.length; i++) {
        const section = typeof spine.get === 'function' ? spine.get(i) : spineItems[i];
        if (!section || typeof section.find !== 'function' || typeof section.load !== 'function') {
          continue;
        }

        try {
          await section.load(epub.load.bind(epub));

          const matches = section.find(query) || [];
          if (matches.length > 0) {
            matches.forEach((match: any) => {
              results.push({
                cfi: match.cfi,
                excerpt: match.excerpt || query,
                sectionIndex: i,
              });
            });
          }
        } catch (err) {
          console.error(`Error searching section ${section.index ?? i}:`, err);
        } finally {
          if (typeof section.unload === 'function') {
            await section.unload();
          }
        }
      }

      setSearchResults(results);
      setLastSearchedQuery(query);
      console.log('[reader-search] search:done', {
        query,
        totalResults: results.length,
        preview: results.slice(0, 5).map((result) => ({
          cfi: result.cfi,
        })),
      });
    } catch (err) {
      console.error('Search error:', err);
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  const triggerSearch = () => {
    handleSearch().catch((err) => {
      console.error('Search trigger error:', err);
    });
  };

  const clearSearchState = () => {
    setSearchQuery('');
    setSearchResults([]);
    setHasTriggeredSearch(false);
    setLastSearchedQuery('');
    clearTemporarySearchHighlight();
  };

  const handleSearchKeyDown = async (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      triggerSearch();
    }
  };

  const normalizeSearchResultCfi = (cfi: string) => {
    if (!cfi.startsWith('epubcfi(') || !cfi.endsWith(')')) {
      return cfi;
    }

    const inner = cfi.slice(8, -1);
    let depth = 0;
    let firstComma = -1;
    let secondComma = -1;

    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === '[' || ch === '(') depth++;
      if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
      if (ch === ',' && depth === 0) {
        if (firstComma === -1) {
          firstComma = i;
        } else {
          secondComma = i;
          break;
        }
      }
    }

    if (firstComma === -1 || secondComma === -1) {
      return cfi;
    }

    const base = inner.slice(0, firstComma);
    const start = inner.slice(firstComma + 1, secondComma);
    return `epubcfi(${base},${start})`;
  };

  const buildSearchNavigationTargets = (cfi: string) => {
    const normalized = normalizeSearchResultCfi(cfi);
    return normalized !== cfi ? [cfi, normalized] : [cfi];
  };

  const isSearchedTextVisible = (query: string) => {
    if (!rendition) return false;
    const expected = query.trim().toLowerCase();
    if (!expected) return true;

    const contents = (rendition as any).getContents?.();
    const contentList = Array.isArray(contents) ? contents : contents ? [contents] : [];

    return contentList.some((content: any) => {
      const text = content?.document?.body?.textContent;
      return typeof text === 'string' && text.toLowerCase().includes(expected);
    });
  };

  const waitForRenditionPaint = async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
  };

  const clearTemporarySearchHighlight = () => {
    if (!rendition || !activeSearchHighlightCfi.current) return;
    try {
      rendition.annotations.remove(activeSearchHighlightCfi.current, 'highlight');
    } catch (err) {
      console.warn('[reader-search] result:highlight-remove-failed', err);
    } finally {
      activeSearchHighlightCfi.current = null;
    }
  };

  const fadeSearchHighlightNodes = () => {
    // Keep the text and highlight overlay crisp; removal is handled by timer.
  };

  const showTemporarySearchHighlight = async (cfi: string) => {
    if (!rendition || !cfi) return;

    if (searchHighlightTimer.current) {
      clearTimeout(searchHighlightTimer.current);
      searchHighlightTimer.current = null;
    }

    clearTemporarySearchHighlight();

    const candidates = buildSearchNavigationTargets(cfi);
    let highlightCfi: string | null = null;

    for (let attempt = 0; attempt < 3 && !highlightCfi; attempt++) {
      if (attempt > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 120 * attempt));
      }

      for (const candidate of candidates) {
        try {
          rendition.annotations.add('highlight', candidate, {}, undefined, 'search-hit-temp', {
            fill: '#FACC15',
            "fill-opacity": "0.40",
          });
          highlightCfi = candidate;
          break;
        } catch {
          // Try alternate candidate / retry after content settles
        }
      }
    }

    if (!highlightCfi) return;

    activeSearchHighlightCfi.current = highlightCfi;

    setTimeout(() => {
      fadeSearchHighlightNodes();
    }, 120);

    searchHighlightTimer.current = setTimeout(() => {
      clearTemporarySearchHighlight();
      if (searchHighlightTimer.current) {
        clearTimeout(searchHighlightTimer.current);
        searchHighlightTimer.current = null;
      }
    }, 2600);
  };

  const navigateToSearchResult = async (result: SearchResult) => {
    if (rendition) {
      console.log('[reader-search] result:click', {
        currentLocation: location,
        cfi: result.cfi,
        sectionIndex: result.sectionIndex,
      });

      try {
        const cfiTargets = buildSearchNavigationTargets(result.cfi);
        const expectedQuery = (lastSearchedQuery || searchQuery).trim();

        let navigated = false;
        let fallbackTarget: string | null = null;

        for (const targetCfi of cfiTargets) {
          try {
            await rendition.display(targetCfi);
            await waitForRenditionPaint();

            if (!fallbackTarget) {
              fallbackTarget = targetCfi;
            }

            if (isSearchedTextVisible(expectedQuery)) {
              console.log('[reader-search] result:navigated', {
                strategy: 'cfi',
                targetCfi,
              });
              navigated = true;
              break;
            }

            console.warn('[reader-search] result:text-not-visible-after-navigation', {
              targetCfi,
              expectedQuery,
            });
          } catch (cfiErr) {
            console.warn('[reader-search] result:cfi-failed', {
              targetCfi,
              cfiErr,
            });
          }
        }

        if (!navigated && fallbackTarget) {
          await rendition.display(fallbackTarget);
          await waitForRenditionPaint();
          console.log('[reader-search] result:navigated', {
            strategy: 'fallback-cfi',
            fallbackTarget,
          });
          navigated = true;
        }

        if (navigated) {
          await showTemporarySearchHighlight(result.cfi);
        }
      } catch (err) {
        console.error('[reader-search] result:navigation-failed', {
          result,
          err,
        });
      }

      setActiveTab(null);
      setShowQuickActions(false);
      flashPageIndicator();
    }
  };

  const handleCenterTouchStart = (e: React.TouchEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    isTouchHold.current = false;
    preventNextClick.current = false;
    if (touchHoldTimer.current) clearTimeout(touchHoldTimer.current);
    touchHoldTimer.current = setTimeout(() => {
      isTouchHold.current = true;
    }, 280);
  };

  const handleCenterTouchEnd = (e: React.TouchEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (touchHoldTimer.current) {
      clearTimeout(touchHoldTimer.current);
      touchHoldTimer.current = null;
    }

    if (isTouchHold.current) {
      isTouchHold.current = false;
      preventNextClick.current = true;
      return;
    }

    toggleControls();
    // Mobile taps fire touchend then a synthetic click. Block that click so one tap toggles once.
    preventNextClick.current = true;
  };

  const handleCenterClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (preventNextClick.current) {
      preventNextClick.current = false;
      return;
    }
    toggleControls();
  };

  const handleReaderTouchStartCapture = (e: React.TouchEvent<HTMLDivElement>) => {
    const touch = e.touches[0];
    if (!touch) return;

    const edgeZone = 32;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const nearEdge = touch.clientX <= edgeZone || touch.clientX >= viewportWidth - edgeZone;

    edgeGestureStart.current = {
      x: touch.clientX,
      y: touch.clientY,
      nearEdge,
    };
  };

  const handleReaderTouchMoveCapture = (e: React.TouchEvent<HTMLDivElement>) => {
    const start = edgeGestureStart.current;
    const touch = e.touches[0];
    if (!start || !touch || !start.nearEdge) return;

    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;

    // Keep edge horizontal swipes inside the reader so OS/browser swipe-back is less likely.
    if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
      e.preventDefault();
    }
  };

  const handleReaderTouchEndCapture = () => {
    edgeGestureStart.current = null;
  };

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const runTransitionController = async (
    dir: NavigationDirection,
    navigate: () => Promise<void>
  ) => {
    const timings: Record<PageTransition, { pre: number; post: number }> = {
      slide: { pre: 100, post: 120 },
      fastfade: { pre: 60, post: 70 },
      curl: { pre: 170, post: 220 },
    };

    const config = timings[pageTransition] || timings.slide;
    setTransitionVisual({ mode: pageTransition, dir, token: Date.now() });

    try {
      await wait(config.pre);
      await navigate();
      await wait(config.post);
    } finally {
      setTransitionVisual(null);
    }
  };

  const animateTransition = async (dir: NavigationDirection) => {
    if (!rendition || isNavigatingRef.current) return;

    // Debounce: reject any navigation that arrives within 400ms of the last one.
    // This blocks the synthetic click that fires after onTouchEnd on mobile, and any
    // other rapid-fire invocations, so a single physical tap always advances by exactly 1.
    const now = Date.now();
    if (now - lastNavTime.current < 400) return;
    lastNavTime.current = now;

    isNavigatingRef.current = true;

    try {
      await runTransitionController(dir, () => {
        return dir === 'next' ? rendition.next() : rendition.prev();
      });
    } catch (err) {
      console.error('Page navigation error:', err);
    } finally {
      isNavigatingRef.current = false;
    }
  };

  const next = async () => animateTransition('next');
  const prev = async () => animateTransition('prev');

  const renderTocItems = (items: TocItem[], depth = 0): ReactElement[] => {
    return items.flatMap((item, i) => {
      const key = `${item.id || item.href || item.label || 'toc'}-${depth}-${i}`;
      const active = isTocItemActive(item);
      const row = (
        <button
          key={key}
          onClick={(e) => {
            e.stopPropagation();
            if (item.href) {
              rendition?.display(item.href);
              closePanel();
            }
          }}
          className={cn(
            'w-full text-left p-4 rounded-xl transition-colors border',
            active
              ? 'bg-zinc-100 dark:bg-zinc-800 border-zinc-300 dark:border-zinc-600'
              : 'hover:bg-zinc-100 dark:hover:bg-zinc-800 border-zinc-100 dark:border-zinc-800'
          )}
          style={{ marginLeft: `${depth * 12}px` }}
        >
          <p className={cn('text-sm font-medium', active && 'font-semibold')}>{item.label || 'Untitled section'}</p>
        </button>
      );

      if (Array.isArray(item.subitems) && item.subitems.length > 0) {
        return [row, ...renderTocItems(item.subitems, depth + 1)];
      }

      return [row];
    });
  };

  return (
    <div 
      className="fixed inset-0 z-50 flex flex-col transition-colors duration-500 overflow-hidden"
      style={{ backgroundColor: getToneColor(pageTone).bg, overscrollBehaviorX: 'none' }}
      onTouchStartCapture={handleReaderTouchStartCapture}
      onTouchMoveCapture={handleReaderTouchMoveCapture}
      onTouchEndCapture={handleReaderTouchEndCapture}
    >
      {/* Top Bar */}
      <AnimatePresence>
        {showControls && (
          <motion.header
            initial={{ y: -18, opacity: 0, filter: 'blur(10px)' }}
            animate={{ y: 0, opacity: 1, filter: 'blur(0px)' }}
            exit={{ y: -14, opacity: 0, filter: 'blur(8px)' }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            style={{ 
              color: getToneColor(pageTone).color
            }}
            className="absolute top-0 left-0 right-0 h-18 px-5 pt-4 flex items-start justify-between z-40 transition-colors duration-500"
          >
            <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-white/36 via-white/16 to-transparent pointer-events-none" />
            <div className="w-10 shrink-0" />
            
            <div className="flex flex-col items-center flex-1 px-4 pt-1">
              <h2 className="font-bold text-sm truncate max-w-[220px]">{book.title}</h2>
            </div>

            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              className="h-10 w-10 rounded-full border border-black/5 bg-white/85 text-zinc-700 shadow-[0_8px_24px_rgba(0,0,0,0.12)] backdrop-blur-xl flex items-center justify-center transition-colors"
              aria-label="Close reader"
            >
              <X size={19} />
            </button>
          </motion.header>
        )}
      </AnimatePresence>

      {/* Highlight Bubble — Step 1: colour picker / Step 2: note + save */}
      <AnimatePresence mode="wait">
        {selectedText && !pendingHighlight && selectionPosition && (
          <motion.div
            key="color-picker"
            initial={{ opacity: 0, scale: 0.85, x: '-50%', y: '-100%' }}
            animate={{ opacity: 1, scale: 1, x: '-50%', y: '-100%' }}
            exit={{ opacity: 0, scale: 0.85, x: '-50%', y: '-100%' }}
            transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
            style={{
              left: Math.min(
                Math.max(selectionPosition.x, 90), // Reduced margins for smaller panel
                (typeof window !== 'undefined' ? window.innerWidth : 375) - 90,
              ),
              top: Math.max(selectionPosition.y - 8, 80),
              position: 'absolute',
              zIndex: 1000,
            }}
            className="flex items-center gap-1.5 p-1.5 bg-white/95 backdrop-blur-3xl rounded-full shadow-[0_10px_40px_rgba(0,0,0,0.28)] border border-white/40"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-1.5 px-1.5">
              {([
                { color: '#FFD700', bg: 'bg-yellow-400' },
                { color: '#90EE90', bg: 'bg-green-400' },
                { color: '#7EBCE6', bg: 'bg-blue-300' },
                { color: '#FF9EAE', bg: 'bg-rose-300' },
              ] as const).map(({ color, bg }) => (
                <motion.button
                  key={color}
                  whileHover={{ scale: 1.18 }}
                  whileTap={{ scale: 0.9 }}
                  onClick={() => {
                    setPendingHighlight({ text: selectedText.text, cfiRange: selectedText.cfiRange, color });
                    setPendingNote('');
                  }}
                  className={`w-7 h-7 rounded-full ${bg} border border-white/50 shadow-sm cursor-pointer flex-shrink-0`}
                />
              ))}
            </div>
            <div className="w-px h-6 bg-black/10" />
            <button
              onClick={() => { setSelectedText(null); setSelectionPosition(null); }}
              className="p-1.5 hover:bg-black/5 rounded-full transition-colors"
            >
              <X size={16} className="text-zinc-500" />
            </button>
          </motion.div>
        )}

        {pendingHighlight && selectionPosition && (
          <motion.div
            key="note-panel"
            initial={{ opacity: 0, scale: 0.88, x: '-50%', y: '-50%' }}
            animate={{ opacity: 1, scale: 1, x: '-50%', y: '-50%' }}
            exit={{ opacity: 0, scale: 0.88, x: '-50%', y: '-50%' }}
            transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
            style={{
              position: 'fixed',
              top: '40%', // slightly above center so keyboard definitely misses it
              left: '50%',
              zIndex: 1000,
              width: '90%',
              maxWidth: '320px',
            }}
            className="bg-white rounded-2xl shadow-[0_20px_60px_rgba(0,0,0,0.35)] border border-white/50 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header: colour dot + truncated text + close */}
            <div className="flex items-center gap-2 px-3 pt-3 pb-2">
              <div
                className="w-3 h-3 rounded-full flex-shrink-0 ring-2 ring-white shadow-sm"
                style={{ backgroundColor: pendingHighlight.color }}
              />
              <p className="text-[11px] text-zinc-400 flex-1 truncate leading-snug">
                {pendingHighlight.text}
              </p>
              <button
                onClick={() => { setPendingHighlight(null); setPendingNote(''); setSelectedText(null); setSelectionPosition(null); }}
                className="p-0.5 hover:bg-black/5 rounded-full transition-colors flex-shrink-0"
              >
                <X size={13} className="text-zinc-400" />
              </button>
            </div>

            <div className="h-px bg-black/[0.06] mx-3" />

            {/* Note textarea — grows up to 3 lines (~72 px) then scrolls */}
            <div className="px-3 pt-2.5 pb-3">
              <textarea
                ref={noteTextareaRef}
                autoFocus
                placeholder="Add a note… (optional)"
                value={pendingNote}
                rows={1}
                onChange={(e) => setPendingNote(e.target.value)}
                onInput={(e) => {
                  const ta = e.currentTarget;
                  ta.style.height = 'auto';
                  ta.style.height = `${Math.min(ta.scrollHeight, 72)}px`;
                }}
                className="w-full resize-none text-sm rounded-xl px-3 py-2 outline-none border-none placeholder:text-zinc-400 text-zinc-800"
                style={{
                  background: 'rgba(0,0,0,0.05)',
                  minHeight: '36px',
                  maxHeight: '72px',
                  overflowY: 'auto',
                  lineHeight: '1.55',
                }}
              />

              <div className="flex items-center gap-2 mt-2">
                <button
                  onClick={() => { setPendingHighlight(null); setPendingNote(''); }}
                  className="flex-1 py-2 rounded-xl text-sm font-semibold text-zinc-500 hover:bg-black/5 transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={() => confirmHighlight(pendingNote)}
                  className="flex-1 py-2 rounded-xl text-sm font-bold text-white transition-opacity active:opacity-80"
                  style={{ background: '#1C1C1E' }}
                >
                  Save
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Eraser Menu */}
      <AnimatePresence>
        {highlightToErase && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8, x: '-50%', y: 10 }}
            animate={{ opacity: 1, scale: 1, x: '-50%', y: -60 }}
            exit={{ opacity: 0, scale: 0.8, x: '-50%', y: 10 }}
            style={{ 
              left: Math.min(
                Math.max(highlightToErase.position.x, 80),
                (typeof window !== 'undefined' ? window.innerWidth : 375) - 80,
              ),
              top: highlightToErase.position.y,
              position: 'absolute',
              zIndex: 100,
            }}
            className="flex items-center gap-3 p-2 bg-white/90 dark:bg-zinc-800/90 backdrop-blur-3xl rounded-full shadow-[0_10px_40px_rgba(0,0,0,0.2)] border border-white/40"
          >
            <button 
              onClick={() => removeHighlight(highlightToErase.cfiRange)}
              className="flex items-center gap-2 px-4 py-1.5 bg-red-500 text-white rounded-full text-[10px] font-black uppercase tracking-widest hover:bg-red-600 transition-all shadow-lg"
            >
              <Trash2 size={14} />
              Erase
            </button>
            <div className="w-px h-6 bg-black/10 dark:bg-white/10" />
            <button 
              onClick={() => setHighlightToErase(null)}
              className="p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-full transition-colors"
            >
              <X size={18} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Viewer */}
      <div 
        className="reader-container flex-1 w-full h-full flex justify-center items-center overflow-hidden relative transition-colors duration-500"
        style={{ backgroundColor: getToneColor(pageTone).bg }}
      >
        <div 
          ref={viewerRef} 
          className={cn(
            "reader-content",
            transitionVisual?.mode === 'slide' && transitionVisual.dir === 'next' && 'anim-slide-next',
            transitionVisual?.mode === 'slide' && transitionVisual.dir === 'prev' && 'anim-slide-prev',
            transitionVisual?.mode === 'fastfade' && 'anim-fastfade',
          )}
          style={{ width: '100%', height: '100%' }}
        />

        {/* Transition visual layer keeps animation strategy decoupled from navigation logic */}
        <AnimatePresence>
          {transitionVisual?.mode === 'curl' && (
            <motion.div
              key={`curl-${transitionVisual.dir}-${transitionVisual.token}`}
              initial={{ opacity: 0.9 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className={cn(
                'curl-overlay absolute inset-0 pointer-events-none z-[25]',
                transitionVisual.dir === 'next' ? 'anim-curl-next' : 'anim-curl-prev'
              )}
            >
              <div className="curl-sheet" />
              <div className={cn('curl-shadow', transitionVisual.dir === 'next' ? 'curl-shadow-next' : 'curl-shadow-prev')} />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Transparent tap zones (20/60/20) — always pointer-events-none so touches
            reach the epub iframe for text selection. Navigation is handled by the
            renditionInstance 'click' event which calls handleRegionTap internally. */}
        <div className="absolute inset-0 z-20 flex select-none pointer-events-none">
          <div className="w-[20%] h-full" />
          <div className="w-[60%] h-full" />
          <div className="w-[20%] h-full" />
        </div>

        {/* Page Indicator Overlay */}
        <AnimatePresence>
          {showPageIndicator && locationsReady && (
            <motion.div
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.18 }}
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none z-30"
            >
              {isPanelVisible && totalPages && locationsReady ? (
                <div className="px-7 py-4 rounded-2xl shadow-xl backdrop-blur-2xl border border-white/20 flex flex-col items-center bg-black/70">
                  <span className="text-white/50 text-[10px] font-bold uppercase tracking-widest">Page</span>
                  <span className="text-white text-3xl font-black leading-none">{currentPage}</span>
                  <span className="text-white/40 text-[11px] font-medium">of {totalPages}</span>
                </div>
              ) : (
                <div className="px-8 py-5 rounded-2xl shadow-xl backdrop-blur-2xl border border-white/20 flex items-center justify-center bg-black/70">
                  <span className="text-white text-4xl font-black leading-none">{currentPage}</span>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
        
        {/* Desktop Navigation Buttons */}
        <button 
          onClick={prev}
          className="hidden md:flex absolute left-4 top-1/2 -translate-y-1/2 w-12 h-12 bg-white/50 hover:bg-white backdrop-blur-sm rounded-full items-center justify-center shadow-sm border border-black/5 transition-all opacity-0 hover:opacity-100 group-hover:opacity-100 z-10"
        >
          <ArrowLeft size={24} className="text-black/50" />
        </button>
        <button 
          onClick={next}
          className="hidden md:flex absolute right-4 top-1/2 -translate-y-1/2 w-12 h-12 bg-white/50 hover:bg-white backdrop-blur-sm rounded-full items-center justify-center shadow-sm border border-black/5 transition-all opacity-0 hover:opacity-100 group-hover:opacity-100 z-10"
        >
          <ArrowRight size={24} className="text-black/50" />
        </button>
      </div>

      {/* Bottom Controls */}
      <AnimatePresence>
        {showControls && !activeTab && (
          <div
            className="absolute left-0 right-0 px-4 z-40 pointer-events-none"
            style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 18px)' }}
          >
            <div className="max-w-md mx-auto flex justify-end">
              <motion.div
                layout
                className="relative pointer-events-auto"
                initial={{ opacity: 0, y: 14, filter: 'blur(10px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, y: 14, filter: 'blur(8px)' }}
                transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
              >
                <AnimatePresence>
                  {showQuickActions && (
                    <motion.div
                      layout
                      initial={{ opacity: 0, y: 8, scale: 0.92, filter: 'blur(10px)' }}
                      animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
                      exit={{ opacity: 0, y: 8, scale: 0.94, filter: 'blur(8px)' }}
                      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                      style={{ transformOrigin: 'bottom right' }}
                      className="absolute bottom-14 right-0 w-60 rounded-[1.45rem] bg-white p-2.5 shadow-[0_8px_30px_rgba(0,0,0,0.12)] border border-black/[0.04]"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openPanel('toc');
                        }}
                        className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold hover:bg-zinc-100"
                      >
                        <List size={16} />
                        Contents
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openPanel('search');
                        }}
                        className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold hover:bg-zinc-100"
                      >
                        <Search size={16} />
                        Search
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openAnnotationsPanel();
                        }}
                        className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold hover:bg-zinc-100"
                      >
                        <Highlighter size={16} />
                        Bookmarks &amp; Highlights
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleBookmark();
                          setShowQuickActions(false);
                        }}
                        className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold hover:bg-zinc-100"
                      >
                        <BookmarkIcon size={16} className={cn(isBookmarked ? 'fill-current text-gold' : '')} />
                        {isBookmarked ? 'Remove Bookmark' : 'Add Bookmark'}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openPanel('settings');
                        }}
                        className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold hover:bg-zinc-100"
                      >
                        <Settings size={16} />
                        Settings
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>

                <motion.button
                  layout
                  whileTap={{ scale: 0.95 }}
                  animate={{
                    scale: showQuickActions ? 1.04 : 1,
                    backgroundColor: 'rgba(255,255,255,0.62)',
                    color: 'rgb(63, 63, 70)',
                    boxShadow: '0 8px 22px rgba(15,23,42,0.08)',
                  }}
                  transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowQuickActions((current) => !current);
                  }}
                  className="h-12 w-12 rounded-full text-zinc-700 backdrop-blur-[22px] flex items-center justify-center"
                  aria-label="Reader actions"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="4" y1="6" x2="20" y2="6" />
                    <line x1="4" y1="11" x2="20" y2="11" />
                    <circle cx="6" cy="17" r="1.5" />
                    <circle cx="12" cy="17" r="1.5" />
                    <circle cx="18" cy="17" r="1.5" />
                  </svg>
                </motion.button>
              </motion.div>
            </div>
          </div>
        )}
      </AnimatePresence>

      {isBookmarked && (
        <div
          className="absolute left-4 z-40"
          style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 18px)' }}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              openAnnotationsPanel('bookmarks');
            }}
            className="h-12 w-12 rounded-full bg-[rgba(255,255,255,0.68)] text-gold shadow-[0_8px_22px_rgba(15,23,42,0.08)] backdrop-blur-[22px] flex items-center justify-center"
            aria-label="Current page bookmarked"
          >
            <BookmarkIcon size={18} className="fill-current" />
          </button>
        </div>
      )}

      {locationsReady && (
        <div
          className="absolute left-1/2 -translate-x-1/2 z-30 pointer-events-none"
          style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 8px)' }}
        >
          <div className="flex flex-col items-center gap-1">
            <div className="rounded-full bg-white/70 px-3 py-1 text-[11px] font-semibold text-zinc-700 shadow-[0_8px_22px_rgba(15,23,42,0.08)] backdrop-blur-[20px] transition-all duration-200">
              {isPanelVisible && totalPages && locationsReady ? `Page ${currentPage} of ${totalPages}` : `${currentPage}`}
            </div>
            {showPaginationDebug && paginationDebug && (
              <div className="rounded-full bg-black/55 px-3 py-1 text-[10px] font-medium text-white/90 shadow-[0_8px_22px_rgba(15,23,42,0.18)] backdrop-blur-[20px]">
                {`CFI ${paginationDebug.index + 1}/${paginationDebug.total} · Sec ${paginationDebug.sectionIndex ?? '-'}`}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Panels */}
      <AnimatePresence>
        {activeTab && (
          <motion.div
            ref={panelRef}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ duration: 0.45, ease: [0.32, 0.72, 0, 1] }}
            onClick={(e) => {
              e.stopPropagation();
            }}
            className="absolute bottom-0 left-0 right-0 rounded-t-[3rem] shadow-[0_-20px_80px_rgba(0,0,0,0.15)] z-40 p-8 pb-12 max-h-[85vh] overflow-y-auto"
            style={{
              backgroundColor: '#FFFFFF',
              color: '#1C1C1E',
              borderTop: '1px solid rgba(0,0,0,0.06)',
            }}
          >
            <div
              className="w-12 h-1.5 rounded-full mx-auto mb-8"
              style={{ backgroundColor: 'rgba(0,0,0,0.12)' }}
            />
            
            <div className="max-w-md mx-auto">
              {activeTab === 'toc' && (
                <div className="space-y-6">
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-sm font-bold" style={{ color: '#1C1C1E' }}>Table of Contents</h3>
                    <button
                      onClick={closePanel}
                      className="p-1.5 rounded-full transition-colors"
                      style={{
                        background: 'rgba(0,0,0,0.06)',
                        color: '#1C1C1E',
                      }}
                    >
                      <X size={16} />
                    </button>
                  </div>
                  
                  <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-2">
                    {toc.length > 0 ? (
                      renderTocItems(toc)
                    ) : (
                      <p className="text-center py-8" style={{ color: `${'#1C1C1E'}E6` }}>No table of contents available.</p>
                    )}
                  </div>
                </div>
              )}

              {activeTab === 'highlights' && (
                <div className="space-y-5">
                  <div className="flex justify-between items-center">
                    <h3 className="text-sm font-bold" style={{ color: '#1C1C1E' }}>Bookmarks &amp; Highlights</h3>
                    <button
                      onClick={closePanel}
                      className="p-1.5 rounded-full transition-colors"
                      style={{
                        background: 'rgba(0,0,0,0.06)',
                        color: '#1C1C1E',
                      }}
                    >
                      <X size={16} />
                    </button>
                  </div>

                  {/* Segmented tab control */}
                  <div
                    className="flex rounded-xl p-1 gap-1"
                    style={{ background: 'rgba(0,0,0,0.06)' }}
                  >
                    <button
                      onClick={() => setAnnotationsTab('bookmarks')}
                      className="flex-1 py-2 rounded-lg text-sm font-semibold transition-all"
                      style={{
                        background: annotationsTab === 'bookmarks'
                          ? 'rgba(255,255,255,0.95)'
                          : 'transparent',
                        color: annotationsTab === 'bookmarks'
                          ? '#1C1C1E'
                          : `${'#1C1C1E'}CC`,
                        boxShadow: annotationsTab === 'bookmarks' ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
                      }}
                    >
                      Bookmarks
                    </button>
                    <button
                      onClick={() => setAnnotationsTab('highlights')}
                      className="flex-1 py-2 rounded-lg text-sm font-semibold transition-all"
                      style={{
                        background: annotationsTab === 'highlights'
                          ? 'rgba(255,255,255,0.95)'
                          : 'transparent',
                        color: annotationsTab === 'highlights'
                          ? '#1C1C1E'
                          : `${'#1C1C1E'}CC`,
                        boxShadow: annotationsTab === 'highlights' ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
                      }}
                    >
                      Highlights
                    </button>
                  </div>

                  {/* Bookmarks list */}
                  {annotationsTab === 'bookmarks' && (
                    <div className="space-y-2 max-h-[55vh] overflow-y-auto pr-2">
                      {sortedBookmarks.length > 0 ? (
                        sortedBookmarks.map((bm, i) => {
                          const chapter = resolveChapterTitle(bm.cfi);
                          return (
                            <div
                              key={i}
                              className="flex items-center gap-3 p-4 rounded-xl"
                              style={{
                                background: 'rgba(0,0,0,0.04)',
                                border: '1px solid rgba(0,0,0,0.07)',
                              }}
                            >
                              <BookmarkIcon size={15} className="text-gold fill-current flex-shrink-0" />
                              <button
                                className="flex-1 text-left"
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  await navigateToBookmark(bm);
                                  closePanel();
                                }}
                              >
                                <p className="text-sm font-semibold leading-snug" style={{ color: '#1C1C1E' }}>
                                  {chapter || 'Bookmark'}
                                </p>
                                <p className="text-[11px] mt-0.5" style={{ color: `${'#1C1C1E'}A6` }}>Saved location</p>
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  deleteBookmark(bm.cfi);
                                }}
                                className="p-1.5 hover:bg-red-500/10 text-red-400 rounded-full transition-colors flex-shrink-0"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          );
                        })
                      ) : (
                        <div className="text-center py-10">
                          <p className="text-sm" style={{ color: `${'#1C1C1E'}A6` }}>No bookmarks yet.</p>
                          <p className="text-xs mt-1" style={{ color: `${'#1C1C1E'}80` }}>Tap "Add Bookmark" in the reader menu.</p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Highlights list */}
                  {annotationsTab === 'highlights' && (
                    <div className="space-y-3 max-h-[55vh] overflow-y-auto pr-2">
                      {highlights.length > 0 ? (
                        highlights.map((h, i) => {
                          const chapter = resolveChapterTitle(h.cfiRange);
                          return (
                            <div
                              key={i}
                              className="p-4 rounded-xl"
                              style={{
                                background: 'rgba(0,0,0,0.04)',
                                border: '1px solid rgba(0,0,0,0.07)',
                              }}
                            >
                              <div className="flex items-start gap-3">
                                <div className="w-3 h-3 rounded-full mt-1 flex-shrink-0" style={{ backgroundColor: h.color }} />
                              <div className="flex-1 min-w-0">
                                  <p className="text-sm mb-1.5 leading-snug" style={{ color: '#1C1C1E' }}>{h.text}</p>
                                  {h.note && (
                                    <p
                                      className="text-xs italic mb-1.5 leading-relaxed"
                                      style={{ color: `${'#1C1C1E'}CC` }}
                                    >
                                      “{h.note}”
                                    </p>
                                  )}
                                  {chapter && <p className="text-[10px] font-medium mb-1.5" style={{ color: `${'#1C1C1E'}A6` }}>{chapter}</p>}
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      rendition?.display(h.cfiRange);
                                      closePanel();
                                    }}
                                    className="text-[10px] font-bold uppercase tracking-wider transition-colors"
                                    style={{ color: `${'#1C1C1E'}CC` }}
                                  >
                                    Go to highlight
                                  </button>
                                </div>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    removeHighlight(h.cfiRange);
                                  }}
                                  className="p-1.5 hover:bg-red-500/10 text-red-500 rounded-full transition-colors flex-shrink-0"
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </div>
                          );
                        })
                      ) : (
                        <div className="text-center py-10">
                          <p className="text-sm" style={{ color: `${'#1C1C1E'}A6` }}>No highlights yet.</p>
                          <p className="text-xs mt-1" style={{ color: `${'#1C1C1E'}80` }}>Select text while reading to highlight it.</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'search' && (
                <div className="space-y-6">
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-sm font-bold" style={{ color: '#1C1C1E' }}>Search</h3>
                    <button
                      onClick={closePanel}
                      className="p-1.5 rounded-full transition-colors"
                      style={{
                        background: 'rgba(0,0,0,0.06)',
                        color: '#1C1C1E',
                      }}
                    >
                      <X size={16} />
                    </button>
                  </div>
                  <div className="space-y-4">
                    <div className="flex items-center gap-3">
                      <div className="relative flex-1">
                        <input
                          type="search"
                          inputMode="search"
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          autoComplete="off"
                          enterKeyHint="search"
                          placeholder="Search in book..."
                          value={searchQuery}
                          onChange={(e) => {
                            setSearchQuery(e.target.value);
                            setHasTriggeredSearch(false);
                          }}
                          onKeyDown={handleSearchKeyDown}
                          className="w-full border-none rounded-xl py-3 pl-10 pr-4 text-sm focus:ring-2 focus:ring-gold outline-none"
                          style={{
                            background: 'rgba(0,0,0,0.06)',
                            color: '#1C1C1E',
                          }}
                        />
                        <Search size={16} className="absolute left-3.5 top-3.5" style={{ color: `${'#1C1C1E'}50` }} />
                      </div>
                      <button
                        type="button"
                        onClick={triggerSearch}
                        disabled={isSearching || !searchQuery.trim()}
                        className="rounded-xl px-4 py-3 text-sm font-semibold text-white transition-opacity disabled:opacity-50"
                        style={{ background: '#1C1C1E' }}
                      >
                        Search
                      </button>
                      <button
                        type="button"
                        onClick={clearSearchState}
                        disabled={!searchQuery && searchResults.length === 0}
                        className="rounded-xl px-4 py-3 text-sm font-semibold transition-opacity disabled:opacity-40"
                        style={{
                          border: '1px solid rgba(0,0,0,0.18)',
                          color: '#1C1C1E',
                        }}
                      >
                        Clear
                      </button>
                    </div>
                    <p className="text-xs text-center" style={{ color: `${'#1C1C1E'}60` }}>
                      {isSearching ? 'Searching...' : searchResults.length > 0 ? `Found ${searchResults.length} result${searchResults.length !== 1 ? 's' : ''}` : ''}
                    </p>
                  </div>

                  {/* Search Results List */}
                  {searchResults.length > 0 ? (
                    <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-2">
                      {searchResults.map((result, idx) => (
                        <button
                          key={idx}
                          onClick={async (e) => {
                            e.stopPropagation();
                            await navigateToSearchResult(result);
                          }}
                          className="w-full text-left p-4 rounded-xl transition-colors"
                          style={{
                            background: 'rgba(0,0,0,0.04)',
                            border: '1px solid rgba(0,0,0,0.07)',
                          }}
                        >
                          <p className="text-sm mb-2 line-clamp-3" style={{ color: '#1C1C1E' }}>{result.excerpt}</p>
                          <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: `${'#1C1C1E'}50` }}>Result {idx + 1}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-center py-8" style={{ color: `${'#1C1C1E'}60` }}>
                      {isSearching ? 'Searching...' : hasTriggeredSearch ? 'No results found.' : 'Tap Search to look in the book'}
                    </p>
                  )}
                </div>
              )}

              {activeTab === 'settings' && (
                <div className="space-y-5">
                  <div className="flex justify-between items-center mb-2">
                    <h3 className="text-sm font-bold" style={{ color: '#1C1C1E' }}>Appearance</h3>
                    <button
                      onClick={closePanel}
                      className="p-1.5 rounded-full transition-colors"
                      style={{
                        background: 'rgba(0,0,0,0.06)',
                        color: '#1C1C1E',
                      }}
                    >
                      <X size={16} />
                    </button>
                  </div>

                  {/* ── Theme picker ── */}
                  <div
                    className="rounded-2xl p-4 space-y-3"
                    style={{
                      background: 'rgba(0,0,0,0.04)',
                    }}
                  >
                    <span
                      className="text-[11px] font-bold uppercase tracking-widest"
                      style={{ color: 'rgba(0,0,0,0.35)' }}
                    >
                      Theme
                    </span>
                    <div className="grid grid-cols-3 gap-3">
                      {([
                        {
                          id: 'light' as const,
                          label: 'Light',
                          bg: '#FAF7F2',
                          color: '#1C1C1E',
                          stripe: '#E8E2D8',
                          icon: '☀️',
                        },
                        {
                          id: 'sepia' as const,
                          label: 'Sepia',
                          bg: '#F4ECD8',
                          color: '#433422',
                          stripe: '#D9C9A8',
                          icon: '📜',
                        },
                        {
                          id: 'dark' as const,
                          label: 'Dark',
                          bg: '#111214',
                          color: '#F4F1E8',
                          stripe: '#2A2A2E',
                          icon: '🌙',
                        },
                      ]).map((t) => {
                        const active = pageTone === t.id;
                        return (
                          <button
                            key={t.id}
                            onClick={() => setPageTone(t.id)}
                            className="relative flex flex-col items-center rounded-2xl overflow-hidden transition-transform active:scale-95"
                            style={{
                              outline: active ? `2.5px solid #C9A84C` : '2.5px solid transparent',
                              outlineOffset: '1px',
                              boxShadow: active
                                ? '0 0 0 4px rgba(201,168,76,0.18)'
                                : '0 2px 8px rgba(0,0,0,0.10)',
                            }}
                            aria-label={`${t.label} theme`}
                          >
                            {/* Swatch preview */}
                            <div
                              className="w-full h-16 flex flex-col justify-center items-start px-3 gap-1.5"
                              style={{ backgroundColor: t.bg }}
                            >
                              {/* Fake text lines */}
                              <div className="w-4/5 h-1.5 rounded-full" style={{ backgroundColor: t.stripe }} />
                              <div className="w-3/5 h-1.5 rounded-full" style={{ backgroundColor: t.stripe }} />
                              <div className="w-4/5 h-1.5 rounded-full" style={{ backgroundColor: t.stripe }} />
                            </div>
                            {/* Label row */}
                            <div
                              className="w-full flex flex-col items-center py-2"
                              style={{
                                backgroundColor: 'rgba(0,0,0,0.04)',
                              }}
                            >
                              <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: '#1C1C1E' }}>
                                {t.label}
                              </span>
                            </div>
                            {/* Active check */}
                            {active && (
                              <div className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-[#C9A84C] flex items-center justify-center shadow">
                                <svg viewBox="0 0 10 10" width="8" height="8" fill="none">
                                  <path d="M2 5l2.2 2.2L8 3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* ── Page Turn picker ── */}
                  <div
                    className="rounded-2xl p-4 space-y-3"
                    style={{
                      background: 'rgba(0,0,0,0.04)',
                    }}
                  >
                    <span
                      className="text-[11px] font-bold uppercase tracking-widest"
                      style={{ color: 'rgba(0,0,0,0.35)' }}
                    >
                      Page Turn
                    </span>
                    <div className="grid grid-cols-3 gap-3">
                      {([
                        { id: 'curl'     as PageTransition, label: 'Curl',  icon: '↷', desc: 'Classic' },
                        { id: 'slide'    as PageTransition, label: 'Slide', icon: '⇄', desc: 'Smooth' },
                        { id: 'fastfade' as PageTransition, label: 'Fade',  icon: '✦', desc: 'Instant' },
                      ]).map((opt) => {
                        const active = pageTransition === opt.id;
                        return (
                          <button
                            key={opt.id}
                            onClick={() => setPageTransition(opt.id)}
                            className="flex flex-col items-center gap-1.5 py-3.5 px-2 rounded-2xl transition-transform active:scale-95"
                            style={{
                              outline: active ? '2.5px solid #C9A84C' : '2.5px solid transparent',
                              outlineOffset: '1px',
                              boxShadow: active
                                ? '0 0 0 4px rgba(201,168,76,0.18)'
                                : '0 2px 8px rgba(0,0,0,0.10)',
                              background: 'rgba(255,255,255,0.85)',
                            }}
                          >
                            <span className="text-xl leading-none">{opt.icon}</span>
                            <span className="text-[11px] font-bold" style={{ color: '#1C1C1E' }}>{opt.label}</span>
                            <span className="text-[9px] opacity-50" style={{ color: '#1C1C1E' }}>{opt.desc}</span>
                            {active && (
                              <div className="absolute" style={{ display: 'none' }} />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
