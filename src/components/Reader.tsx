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
  const [pageTone, setPageTone] = useState<'light' | 'sepia' | 'dark'>('light');

  // Page transitions
  const [pageTransition, setPageTransition] = useState<PageTransition>('curl');
  const [showPageIndicator, setShowPageIndicator] = useState(false);
  const [transitionVisual, setTransitionVisual] = useState<TransitionVisualState | null>(null);
  const pageIndicatorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isNavigatingRef = useRef(false);
  const sectionPageTotalsRef = useRef<number[]>([]);
  const sectionOffsetsRef = useRef<number[]>([]);
  const paginationRecalcTokenRef = useRef(0);

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
        'padding': '24px 16px !important',
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
        'margin': '0 auto !important',
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
        '-webkit-user-select': 'text !important',
        '-moz-user-select': 'text !important',
        'user-select': 'text !important',
      },
      '::selection': {
        'background': 'transparent !important',
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

    const syncPaginationFromLocation = (loc: any) => {
      const metrics = calculateDynamicPageMetrics(loc);
      if (!metrics.cfi) return;

      setLocation(metrics.cfi);
      setProgress(metrics.progress);
      setCurrentPage(metrics.current);
      setTotalPages(metrics.total);
      setLocationsReady(metrics.total !== null && metrics.total > 0);
      updateProgressInDb(metrics.progress, metrics.cfi);
    };

    const handleRegionTap = (x: number) => {
      const width = viewerRef.current?.clientWidth || window.innerWidth;
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
    };

    // Pre-load cached locations before first render so the relocated event already
    // has the full CFI array and can show the correct "Page X of Y" immediately.
    if (book.cachedLocations && typeof locationsApi?.load === 'function') {
      try {
        locationsApi.load(book.cachedLocations);
        preloadedTotal = typeof locationsApi.length === 'function' ? locationsApi.length() : 0;
        if (preloadedTotal > 0) {
          locationsPreloaded = true;
          setTotalPages(preloadedTotal);
          setLocationsReady(true);
        }
      } catch (err) {
        console.warn('[reader-pagination] locations:preload-failed', err);
      }
    }

    const generateAndCacheLocations = async () => {
      try {
        setLocationsReady(false);
        setTotalPages(null);
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
          setTotalPages(generatedTotal);
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
          setTotalPages(renderedTotal);
          setLocationsReady(true);
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
        applyStyles(renditionInstance, pageTone);
      }
    });

    // Add smooth transition to iframe body and suppress native menu
    renditionInstance.hooks.content.register((contents: any) => {
      const body = contents.document.body;
      const html = contents.document.documentElement;
      if (body) {
        body.style.margin = '0';
        body.style.padding = '0';
        body.style.width = '100%';
        body.style.boxSizing = 'border-box';
        body.style.webkitTouchCallout = 'none'; // Suppress mobile callout menu
      }

      // Suppress native context menu
      contents.document.addEventListener('contextmenu', (e: Event) => {
        e.preventDefault();
      });
    });

    renditionInstance.on('relocated', (loc: any) => {
      if (!isMounted) return;
      syncPaginationFromLocation(loc);
    });

    renditionInstance.on('click', (e: any) => {
      // Check if clicked on a highlight
      if (e.target && typeof e.target.closest === 'function' && e.target.closest('.hl-class')) {
        return;
      }

      const contents = (renditionInstance as any).getContents();
      let hasSelection = false;
      
      const checkSelection = (win: Window) => {
        const sel = win.getSelection();
        return !!sel && sel.toString().trim().length > 0;
      };

      if (Array.isArray(contents) && contents.length > 0) {
        hasSelection = contents.some((content: any) => checkSelection(content.window));
      } else if (contents && contents.window) {
        hasSelection = checkSelection(contents.window);
      }

      if (hasSelection) {
        if (selectedText) {
          if (Array.isArray(contents) && contents.length > 0) {
            contents[0].window.getSelection()?.removeAllRanges();
          } else if (contents && contents.window) {
            contents.window.getSelection()?.removeAllRanges();
          }
          setActiveTab(null);
          setSelectedText(null);
          setHighlightToErase(null);
        }
      } else {
        handleRegionTap(e.clientX);
      }
    });

    renditionInstance.on('selected', (cfiRange: string, contents: any, selection: Selection) => {
      const iframeSelection = contents?.window?.getSelection?.() || selection;
      if (!iframeSelection || iframeSelection.rangeCount === 0) {
        return;
      }

      // Immediately clear native selection so the OS menu does not overlap our UI
      iframeSelection.removeAllRanges();
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

      recalcLayoutPaginationInBackground().catch((err) => {
        console.warn('[reader-pagination] layout:background-recalc-failed', err);
      });

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

  // Re-apply styles when tone changes.
  useEffect(() => {
    if (rendition) {
      applyStyles(rendition, pageTone);
    }
  }, [pageTone, rendition]);



  const updateProgressInDb = async (p: number, loc: string) => {
    if (book.id) {
      await db.books.update(book.id, {
        progress: p,
        lastLocation: loc
      });
    }
  };

  const addHighlight = async (color: string = '#FFD700') => {
    if (!selectedText || !rendition || !book.id) return;

    const newHighlight: Highlight = {
      cfiRange: selectedText.cfiRange,
      text: selectedText.text,
      color,
      addedAt: Date.now()
    };

    const updatedHighlights = [...highlights, newHighlight];
    setHighlights(updatedHighlights);
    
    rendition.annotations.add('highlight', selectedText.cfiRange, {}, (e: any) => {
      const rect = e.target.getBoundingClientRect();
      setHighlightToErase({
        cfiRange: selectedText.cfiRange,
        position: { x: rect.left + rect.width / 2, y: rect.top }
      });
    }, 'hl-class', { fill: color });
    
    await db.books.update(book.id, { highlights: updatedHighlights });
    setSelectedText(null);
  };

  const removeHighlight = async (cfiRange: string) => {
    if (!rendition || !book.id) return;

    const updatedHighlights = highlights.filter(h => h.cfiRange !== cfiRange);
    setHighlights(updatedHighlights);
    
    rendition.annotations.remove(cfiRange, 'highlight');
    
    await db.books.update(book.id, { highlights: updatedHighlights });
    setSelectedText(null);
    setHighlightToErase(null);
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
            'fill-opacity': '0.40',
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

      {/* Selection Menu */}
      <AnimatePresence>
        {selectedText && selectionPosition && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8, y: 0 }}
            animate={{ opacity: 1, scale: 1, y: -60 }}
            exit={{ opacity: 0, scale: 0.8 }}
            style={{ 
              left: selectionPosition.x, 
              top: selectionPosition.y,
              position: 'absolute',
              zIndex: 1000,
              transform: 'translateX(-50%)'
            }}
            className="flex items-center gap-3 p-2 bg-white/95 dark:bg-zinc-800/95 backdrop-blur-3xl rounded-full shadow-[0_10px_40px_rgba(0,0,0,0.3)] border border-white/40"
          >
            <div className="flex items-center gap-2 px-2">
              <motion.button 
                whileHover={{ scale: 1.2 }}
                whileTap={{ scale: 0.9 }}
                onClick={() => addHighlight('#FFD700')}
                className="w-8 h-8 rounded-full bg-yellow-400 border-2 border-white shadow-sm cursor-pointer"
              />
              <motion.button 
                whileHover={{ scale: 1.2 }}
                whileTap={{ scale: 0.9 }}
                onClick={() => addHighlight('#90EE90')}
                className="w-8 h-8 rounded-full bg-green-400 border-2 border-white shadow-sm cursor-pointer"
              />
              <motion.button 
                whileHover={{ scale: 1.2 }}
                whileTap={{ scale: 0.9 }}
                onClick={() => addHighlight('#ADD8E6')}
                className="w-8 h-8 rounded-full bg-blue-400 border-2 border-white shadow-sm cursor-pointer"
              />
            </div>
            <div className="w-px h-6 bg-black/10 dark:bg-white/10" />
            <button 
              onClick={() => setSelectedText(null)}
              className="p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-full transition-colors"
            >
              <X size={18} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Eraser Menu */}
      <AnimatePresence>
        {highlightToErase && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: -50 }}
            exit={{ opacity: 0, scale: 0.8 }}
            style={{ 
              left: highlightToErase.position.x, 
              top: highlightToErase.position.y,
              position: 'absolute',
              zIndex: 100,
              transform: 'translateX(-50%)'
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

        {/* Transparent tap zones (20/60/20) for reliable click behavior */}
        <div className={cn(
          "absolute inset-0 z-20 flex select-none",
          activeTab || showQuickActions ? "pointer-events-none" : "pointer-events-auto"
        )}>
          <button
            type="button"
            className="w-[20%] h-full bg-transparent"
            onClick={(e) => { e.stopPropagation(); prev().catch(console.error); }}
            onTouchEnd={(e) => { e.stopPropagation(); prev().catch(console.error); }}
            aria-label="Previous page"
          />
          <button
            type="button"
            className="w-[60%] h-full bg-transparent"
            onTouchStart={handleCenterTouchStart}
            onTouchEnd={handleCenterTouchEnd}
            onClick={handleCenterClick}
            aria-label="Toggle controls"
          />
          <button
            type="button"
            className="w-[20%] h-full bg-transparent"
            onClick={(e) => { e.stopPropagation(); next().catch(console.error); }}
            onTouchEnd={(e) => { e.stopPropagation(); next().catch(console.error); }}
            aria-label="Next page"
          />
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
                      className="absolute bottom-14 right-0 w-60 rounded-[1.45rem] bg-white/[0.96] dark:bg-zinc-900/95 p-2.5 shadow-[0_8px_30px_rgba(0,0,0,0.08)] backdrop-blur-xl border border-black/[0.04]"
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
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            onClick={(e) => {
              e.stopPropagation();
            }}
            className="absolute bottom-0 left-0 right-0 bg-white/[0.96] dark:bg-zinc-900/95 backdrop-blur-2xl rounded-t-[2.5rem] shadow-[0_-4px_24px_rgba(0,0,0,0.08)] z-40 p-8 pb-12 max-h-[85vh] overflow-y-auto border-t border-black/[0.04]"
          >
            <div className="w-12 h-1.5 bg-black/10 dark:bg-white/10 rounded-full mx-auto mb-8" />
            
            <div className="max-w-md mx-auto">
              {activeTab === 'toc' && (
                <div className="space-y-6">
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-sm font-bold">Table of Contents</h3>
                    <button onClick={closePanel} className="p-1 hover:bg-black/5 rounded-full">
                      <X size={18} />
                    </button>
                  </div>
                  
                  <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-2">
                    {toc.length > 0 ? (
                      renderTocItems(toc)
                    ) : (
                      <p className="text-center py-8 text-ink/50">No table of contents available.</p>
                    )}
                  </div>
                </div>
              )}

              {activeTab === 'highlights' && (
                <div className="space-y-5">
                  <div className="flex justify-between items-center">
                    <h3 className="text-sm font-bold">Bookmarks &amp; Highlights</h3>
                    <button onClick={closePanel} className="p-1 hover:bg-black/5 rounded-full">
                      <X size={18} />
                    </button>
                  </div>

                  {/* Segmented tab control */}
                  <div className="flex bg-zinc-100 dark:bg-zinc-800/50 rounded-xl p-1 gap-1">
                    <button
                      onClick={() => setAnnotationsTab('bookmarks')}
                      className={cn(
                        'flex-1 py-2 rounded-lg text-sm font-semibold transition-all',
                        annotationsTab === 'bookmarks'
                          ? 'bg-white dark:bg-zinc-700 shadow-sm text-ink'
                          : 'text-ink/50'
                      )}
                    >
                      Bookmarks
                    </button>
                    <button
                      onClick={() => setAnnotationsTab('highlights')}
                      className={cn(
                        'flex-1 py-2 rounded-lg text-sm font-semibold transition-all',
                        annotationsTab === 'highlights'
                          ? 'bg-white dark:bg-zinc-700 shadow-sm text-ink'
                          : 'text-ink/50'
                      )}
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
                              className="flex items-center gap-3 p-4 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-100 dark:border-zinc-700"
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
                                <p className="text-sm font-semibold text-ink dark:text-white leading-snug">
                                  {chapter || 'Bookmark'}
                                </p>
                                <p className="text-[11px] text-ink/50 mt-0.5">Saved location</p>
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
                          <p className="text-sm text-ink/50">No bookmarks yet.</p>
                          <p className="text-xs text-ink/30 mt-1">Tap "Add Bookmark" in the reader menu.</p>
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
                            <div key={i} className="p-4 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-100 dark:border-zinc-700">
                              <div className="flex items-start gap-3">
                                <div className="w-3 h-3 rounded-full mt-1 flex-shrink-0" style={{ backgroundColor: h.color }} />
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm text-ink dark:text-white mb-1.5 leading-snug">{h.text}</p>
                                  {chapter && <p className="text-[10px] text-ink/40 font-medium mb-1.5">{chapter}</p>}
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      rendition?.display(h.cfiRange);
                                      closePanel();
                                    }}
                                    className="text-[10px] font-bold uppercase tracking-wider text-ink/50 hover:text-ink transition-colors"
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
                          <p className="text-sm text-ink/50">No highlights yet.</p>
                          <p className="text-xs text-ink/30 mt-1">Select text while reading to highlight it.</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'search' && (
                <div className="space-y-6">
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-sm font-bold">Search</h3>
                    <button onClick={closePanel} className="p-1 hover:bg-black/5 rounded-full">
                      <X size={18} />
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
                          className="w-full bg-zinc-100 dark:bg-zinc-800 border-none rounded-xl py-3 pl-10 pr-4 text-sm focus:ring-2 focus:ring-gold outline-none"
                        />
                        <Search size={16} className="absolute left-3.5 top-3.5 text-zinc-400" />
                      </div>
                      <button
                        type="button"
                        onClick={triggerSearch}
                        disabled={isSearching || !searchQuery.trim()}
                        className="rounded-xl bg-black px-4 py-3 text-sm font-semibold text-white transition-opacity disabled:opacity-50"
                      >
                        Search
                      </button>
                      <button
                        type="button"
                        onClick={clearSearchState}
                        disabled={!searchQuery && searchResults.length === 0}
                        className="rounded-xl border border-zinc-300 px-4 py-3 text-sm font-semibold text-zinc-700 transition-opacity disabled:opacity-40"
                      >
                        Clear
                      </button>
                    </div>
                    <p className="text-xs text-center text-zinc-500">
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
                          className="w-full text-left p-4 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-100 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                        >
                          <p className="text-sm text-ink dark:text-white mb-2 line-clamp-3">{result.excerpt}</p>
                          <span className="text-[10px] font-bold uppercase tracking-wider text-ink/50">Result {idx + 1}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-center py-8 text-ink/50">
                      {isSearching ? 'Searching...' : hasTriggeredSearch ? 'No results found.' : 'Tap Search to look in the book'}
                    </p>
                  )}
                </div>
              )}

              {activeTab === 'settings' && (
                <div className="space-y-6">
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-sm font-bold">Settings</h3>
                    <button onClick={closePanel} className="p-1 hover:bg-black/5 rounded-full">
                      <X size={18} />
                    </button>
                  </div>
                  <div className="p-4 rounded-xl bg-zinc-50 border border-zinc-100">
                    <div className="flex flex-col gap-3">
                      <span className="text-sm font-medium">Theme</span>
                      <div className="flex gap-3">
                        <button
                          onClick={() => setPageTone('light')}
                          className={cn(
                            "flex-1 py-2 rounded-lg border-2 font-medium text-sm transition-colors",
                            pageTone === 'light' ? "border-gold text-ink" : "border-transparent bg-white text-ink/70 hover:bg-white/80"
                          )}
                          style={{ backgroundColor: '#FAF7F2' }}
                        >
                          Light
                        </button>
                        <button
                          onClick={() => setPageTone('sepia')}
                          className={cn(
                            "flex-1 py-2 rounded-lg border-2 font-medium text-sm transition-colors",
                            pageTone === 'sepia' ? "border-gold text-[#433422]" : "border-transparent text-[#433422]/70 hover:opacity-80"
                          )}
                          style={{ backgroundColor: '#F4ECD8' }}
                        >
                          Sepia
                        </button>
                        <button
                          onClick={() => setPageTone('dark')}
                          className={cn(
                            "flex-1 py-2 rounded-lg border-2 font-medium text-sm transition-colors",
                            pageTone === 'dark' ? "border-gold text-[#F4F1E8]" : "border-transparent text-[#F4F1E8]/70 hover:opacity-80"
                          )}
                          style={{ backgroundColor: '#111214' }}
                        >
                          Dark
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="p-4 rounded-xl bg-zinc-50 border border-zinc-100">
                    <div className="flex flex-col gap-3">
                      <span className="text-sm font-medium">Page Turn Style</span>
                      <div className="grid grid-cols-3 gap-2">
                        {([
                          { id: 'curl',     label: 'Curl',      icon: '↷', desc: 'Page curl feel' },
                          { id: 'slide',    label: 'Slide',     icon: '⇄', desc: 'Smooth slide'   },
                          { id: 'fastfade', label: 'Fade',      icon: '✦', desc: 'Quick crossfade' },
                        ] as { id: PageTransition; label: string; icon: string; desc: string }[]).map(opt => (
                          <button
                            key={opt.id}
                            onClick={() => setPageTransition(opt.id)}
                            className={cn(
                              "flex flex-col items-center gap-1 py-3 px-2 rounded-xl border-2 transition-all text-center",
                              pageTransition === opt.id
                                ? "border-gold bg-gold/10 shadow-sm"
                                : "border-transparent bg-white hover:bg-white/80"
                            )}
                          >
                            <span className="text-xl">{opt.icon}</span>
                            <span className="text-xs font-bold">{opt.label}</span>
                            <span className="text-[10px] opacity-50">{opt.desc}</span>
                          </button>
                        ))}
                      </div>
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
