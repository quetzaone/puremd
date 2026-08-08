import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import MarkdownEditor from "./editor/MarkdownEditor";
import { LoadedFile, PreflightFile } from "./file/fileState";
import MarkdownPreview, {
  hostOf,
  type ImageFailure,
  type ImageNotes,
  type LightboxImage,
  MAX_IMAGES_PER_DOCUMENT,
  retryAllImages,
  retryFailedImages
} from "./markdown/MarkdownPreview";
import { LANGUAGES, type Language, localeTags, type Strings, translations } from "./i18n";
import Minimap from "./ui/Minimap";
import Outline, { type Heading } from "./ui/Outline";
import MarkdownGuide from "./ui/MarkdownGuide";
import { useFind } from "./ui/useFind";
import {
  ChevronsIcon,
  CloudDownloadIcon,
  DownloadIcon,
  EyeIcon,
  FileIcon,
  FileLinesIcon,
  FolderIcon,
  LinkIcon,
  MenuIcon,
  PanelIcon,
  PencilIcon,
  PlusIcon,
  SaveIcon,
  SearchIcon,
  ShieldIcon,
  WarningIcon,
  WinCloseIcon,
  WinMaximizeIcon,
  WinMinimizeIcon,
  WinRestoreIcon
} from "./ui/icons";

declare const __APP_VERSION__: string;

type Mode = "preview" | "edit";
type PreviewSecurity = "safe" | "extended";

type FileMetadata = { modifiedMs: number };

type TabState = {
  id: string;
  path: string | null;
  name: string;
  content: string;
  originalContent: string;
  modifiedMs: number | null;
  mode: Mode;
  previewSecurity: PreviewSecurity;
  /** Second image root the user authorized for this document, for display and
   *  revocation. The grant itself lives in Rust and dies with the process. */
  imageFolder: string | null;
  /** Remote image URLs the user chose to load in this document. Mirrors what
   *  Rust approved — Rust is the one that answers the network with it. */
  remoteAllowed: string[];
};

type RecentFile = { path: string; name: string };

type DialogKind = "warn" | "danger" | "shield" | "link";
type DialogActionValue = "ok" | "cancel" | "save" | "discard" | "overwrite" | "load" | "enable";

type DialogAction = { value: DialogActionValue; label: string; kind?: "primary" | "danger" };

type AppDialogState = {
  kind: DialogKind;
  title: string;
  message: string;
  detail?: string;
  actions: DialogAction[];
};

type Settings = {
  sidebarOpen: boolean;
  minimapOn: boolean;
  restoreTabs: boolean;
  minimapGhostOpacity: number;
};

const STORAGE_KEYS = {
  language: "puremd-language",
  session: "puremd-session",
  recent: "puremd-recent-files",
  settings: "puremd-settings"
};

const MAX_OPEN_TABS = 50;
const MAX_RECENT_FILES = 8;

// One or two letters hit nearly every line, so the minimap turns into a solid
// bar that marks nothing. Find itself still runs from the first character.
const MINIMAP_TICK_MIN_QUERY = 3;

const DEFAULT_SETTINGS: Settings = {
  sidebarOpen: false,
  minimapOn: true,
  restoreTabs: true,
  minimapGhostOpacity: 0.22
};

const findingLabels: Record<string, keyof Strings> = {
  rawHtml: "findingRawHtml",
  unsafeUri: "findingUnsafeUri",
  remoteImages: "findingRemoteImages",
  largeDataUri: "findingLargeDataUri",
  longLines: "findingLongLines",
  excessiveLinks: "findingExcessiveLinks",
  excessiveImages: "findingExcessiveImages"
};

function getInitialLanguage(): Language {
  const saved = localStorage.getItem(STORAGE_KEYS.language);
  if (saved === "en" || saved === "ru" || saved === "es") {
    return saved;
  }

  const tag = navigator.language.toLowerCase();
  return LANGUAGES.find((language) => tag.startsWith(language)) || "en";
}

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createUntitledTab(index: number): TabState {
  return {
    id: makeId(),
    path: null,
    name: `Untitled ${index}.md`,
    content: "",
    originalContent: "",
    modifiedMs: null,
    mode: "edit",
    previewSecurity: "safe",
    imageFolder: null,
    remoteAllowed: []
  };
}

function tabFromLoadedFile(file: LoadedFile): TabState {
  return {
    id: makeId(),
    path: file.path,
    name: file.name,
    content: file.content,
    originalContent: file.content,
    modifiedMs: file.modifiedMs,
    mode: "preview",
    previewSecurity: "safe",
    imageFolder: null,
    remoteAllowed: []
  };
}

function safeParseJson<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Sessions live in `localStorage`, which holds a few megabytes for the whole
 * application, while a document is allowed to be 20 MiB. A document past this
 * stays open and is simply not restored next time.
 *
 * The alternative is what used to happen: the write threw `QuotaExceededError`
 * out of an effect, and the session went with it — every tab, not just the one
 * that was too big.
 */
const MAX_PERSISTED_TAB_CHARS = 512 * 1024;

function shouldPersistTab(tab: TabState) {
  return (
    (Boolean(tab.path) || tab.content !== tab.originalContent) &&
    tab.content.length <= MAX_PERSISTED_TAB_CHARS
  );
}

/** A stored tab keeps one copy of its text. A tab with no unsaved changes has
 *  the same string in both fields, and it used to be written down twice. */
type PersistedTab = Omit<TabState, "originalContent"> & { originalContent?: string };

function packTab(tab: TabState): PersistedTab {
  return tab.content === tab.originalContent ? { ...tab, originalContent: undefined } : tab;
}

function unpackTab(tab: PersistedTab): TabState {
  // `??`, not `||`: a tab edited away from an empty original has a real, empty
  // original, and treating that as absent would restore it as unmodified.
  return { ...tab, originalContent: tab.originalContent ?? tab.content };
}

/** `localStorage` throws when the quota is gone or storage is switched off, and
 *  every one of these writes runs inside an effect, where that takes the render
 *  down with it. A stale value would be restored as if it were current, so the
 *  key is dropped rather than left behind. */
function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage is unavailable outright; there is nothing left to tidy up.
    }
  }
}

function countWords(text: string) {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu) || []).length;
}

/**
 * The letter a Ctrl shortcut should be judged by, whatever the active layout.
 *
 * `event.key` carries the character the layout produces, so on a Russian layout
 * Ctrl+F arrives as "а" and every shortcut misses. WebView2 then answers the
 * Ctrl+F nobody claimed with its own find bar, which searches the entire window
 * — sidebar and tab titles included. Falling back to the physical key fixes
 * that, but only as a fallback: a Latin layout such as AZERTY must keep
 * matching the letters printed on its own keycaps, not the US positions.
 */
function shortcutLetter(event: KeyboardEvent) {
  const key = event.key.toLowerCase();
  if (/^[a-z]$/.test(key)) {
    return key;
  }
  return /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : key;
}

const REMOTE_IMAGE_PATTERN =
  /!\[[^\]]*\]\(\s*(https?:\/\/[^\s)"']+)|<img\b[^>]*\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']/gi;

// ponytail: only feeds the button's count and the list of hosts in the dialog.
// Rust re-checks every URL against the file before it opens a connection, and a
// URL this misses still has its own button on the placeholder.
function remoteImageSources(content: string) {
  const found = new Set<string>();
  for (const match of content.matchAll(REMOTE_IMAGE_PATTERN)) {
    const source = match[1] || match[2];
    if (source) {
      found.add(source);
    }
  }

  return [...found];
}


export default function App() {
  const [language, setLanguage] = useState<Language>(getInitialLanguage);
  const [settings, setSettings] = useState<Settings>(() => ({
    ...DEFAULT_SETTINGS,
    ...safeParseJson<Partial<Settings>>(localStorage.getItem(STORAGE_KEYS.settings), {})
  }));
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>(() =>
    safeParseJson<RecentFile[]>(localStorage.getItem(STORAGE_KEYS.recent), [])
  );
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [pendingInitialFile, setPendingInitialFile] = useState<PreflightFile | null>(null);

  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [dialog, setDialog] = useState<AppDialogState | null>(null);
  const [lightbox, setLightbox] = useState<LightboxImage | null>(null);

  const [headings, setHeadings] = useState<Heading[]>([]);
  const [viewport, setViewport] = useState({ top: 0, height: 1 });
  const [windowHeight, setWindowHeight] = useState(() => window.innerHeight);
  const [maximized, setMaximized] = useState(false);
  const [hoveredTabId, setHoveredTabId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const findRootRef = useRef<HTMLDivElement | null>(null);
  const tabsRowRef = useRef<HTMLDivElement | null>(null);
  const tabsDragRef = useRef({ active: false, moved: false, captured: false, startScrollLeft: 0, startX: 0 });
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const paletteInputRef = useRef<HTMLInputElement | null>(null);
  const dialogResolverRef = useRef<((value: DialogActionValue) => void) | null>(null);
  const externalChangeRef = useRef<string | null>(null);
  const measureFrameRef = useRef(0);

  const t = translations[language];
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || null;
  const dirty = activeTab ? activeTab.content !== activeTab.originalContent : false;
  const onHome = !activeTab;
  const isEmptyDocument = !activeTab?.content.trim();
  const minimapShown = settings.minimapOn && !isEmptyDocument;
  const extended = activeTab?.previewSecurity === "extended";

  // MarkdownPreview is memoised because it re-parses the whole document on every
  // render. That only pays off while its props keep their identity, so the notes
  // are memoised and the handlers below are stable wrappers over a live ref.
  const imageNotes: ImageNotes = useMemo(
    () => ({
      blocked: t.imageBlocked,
      remote: t.imageRemote,
      remoteUnsaved: t.imageRemoteUnsaved,
      remoteFailed: t.imageRemoteFailed,
      missing: t.imageMissing,
      unauthorized: t.imageUnauthorized,
      outsideFolder: t.imageOutsideFolder,
      unsupported: t.imageUnsupported,
      tooLarge: t.imageTooLarge,
      tooMany: t.imageTooMany
    }),
    [t]
  );

  const previewHandlers = useRef({ showBlockedLink, openExternalLink, showImageNotice });
  previewHandlers.current = { showBlockedLink, openExternalLink, showImageNotice };

  const onBlockedLink = useCallback(() => previewHandlers.current.showBlockedLink(), []);
  const onOpenLink = useCallback(
    (href: string) => void previewHandlers.current.openExternalLink(href),
    []
  );
  const onImageNotice = useCallback(
    (source: string, failure: ImageFailure) =>
      void previewHandlers.current.showImageNotice(source, failure),
    []
  );

  const remoteSources = useMemo(
    () => (extended && activeTab?.path ? remoteImageSources(activeTab.content) : []),
    [activeTab?.content, activeTab?.path, extended]
  );
  // Capped by the same ceiling the preview honours: past it nothing renders, so
  // promising to load more than that would be a number nobody can cash.
  const pendingRemote = remoteSources
    .filter((source) => !activeTab?.remoteAllowed.includes(source))
    .slice(0, MAX_IMAGES_PER_DOCUMENT);

  // stable identity: a new string here would re-run the search on every render
  const findRevision = useMemo(
    () => `${activeTabId}|${activeTab?.mode}|${activeTab?.previewSecurity}|${activeTab?.content}`,
    [activeTabId, activeTab?.mode, activeTab?.previewSecurity, activeTab?.content]
  );

  const find = useFind({
    scrollRef,
    rootRef: findRootRef,
    query: findQuery,
    active: findOpen && !onHome,
    revision: findRevision
  });

  const wordCount = useMemo(() => {
    if (!activeTab) {
      return "";
    }
    if (!activeTab.content) {
      return t.emptyNotSaved;
    }

    const locale = localeTags[language];
    return `${countWords(activeTab.content).toLocaleString(locale)} ${t.words} · ${activeTab.content.length.toLocaleString(locale)} ${t.characters}`;
  }, [activeTab, language, t]);

  // ── persistence ─────────────────────────────────────────────────────────

  useEffect(() => {
    void loadInitialState();
  }, []);

  useEffect(() => {
    persist(STORAGE_KEYS.language, language);
  }, [language]);

  useEffect(() => {
    persist(STORAGE_KEYS.settings, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    persist(STORAGE_KEYS.recent, JSON.stringify(recentFiles.slice(0, MAX_RECENT_FILES)));
  }, [recentFiles]);

  useEffect(() => {
    if (!sessionLoaded) {
      return;
    }

    const persistedTabs = tabs.filter(shouldPersistTab);
    const persistedActiveTabId = persistedTabs.some((tab) => tab.id === activeTabId)
      ? activeTabId
      : persistedTabs[0]?.id || null;
    persist(
      STORAGE_KEYS.session,
      JSON.stringify({ tabs: persistedTabs.map(packTab), activeTabId: persistedActiveTabId })
    );
  }, [activeTabId, sessionLoaded, tabs]);

  useEffect(() => {
    if (!sessionLoaded) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => void invoke("show_main_window"));
    });

    return () => cancelAnimationFrame(frame);
  }, [sessionLoaded]);

  useEffect(() => {
    const title = `${t.appName} - ${activeTab?.name || t.noFile}${dirty ? " *" : ""}`;
    void invoke("set_window_title", { title });
  }, [activeTab?.name, dirty, t]);

  useEffect(() => {
    const node = tabsRowRef.current;
    const activeNode = node?.querySelector<HTMLElement>(".pm-tab.is-active");
    if (!node || !activeNode) {
      return;
    }

    if (tabs[tabs.length - 1]?.id === activeTabId) {
      node.scrollLeft = node.scrollWidth;
      return;
    }

    activeNode.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, tabs.length]);

  // ── window chrome ───────────────────────────────────────────────────────

  useEffect(() => {
    void invoke<boolean>("is_main_window_maximized").then(setMaximized).catch(() => undefined);

    const unlisten = listen<boolean>("window-maximized", (event) => setMaximized(event.payload));
    return () => void unlisten.then((dispose) => dispose());
  }, []);

  // ── scroll / outline measurement ────────────────────────────────────────

  const measure = useCallback(() => {
    const node = scrollRef.current;
    if (!node || !node.scrollHeight || !node.clientHeight) {
      return;
    }

    const height = Math.min(1, node.clientHeight / node.scrollHeight);
    const top = Math.max(0, Math.min(1 - height, node.scrollTop / node.scrollHeight));
    setViewport((current) =>
      Math.abs(height - current.height) > 0.0015 || Math.abs(top - current.top) > 0.0015
        ? { top, height }
        : current
    );
  }, []);

  function scheduleMeasure() {
    if (measureFrameRef.current) {
      return;
    }

    measureFrameRef.current = requestAnimationFrame(() => {
      measureFrameRef.current = 0;
      measure();
    });
  }

  useEffect(() => {
    function onResize() {
      setWindowHeight(window.innerHeight);
      measure();
    }

    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measure]);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node) {
      node.scrollTop = 0;
    }
    setViewport({ top: 0, height: 1 });
  }, [activeTabId, activeTab?.mode]);

  // Measure when the content actually changes size, not after every render.
  // Re-measuring on each render feeds setViewport back into rendering, and near
  // the bottom — where `top` clamps and images are still settling — the two
  // never agree and the view visibly oscillates.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) {
      return;
    }

    const observer = new ResizeObserver(() => scheduleMeasure());
    observer.observe(node);
    for (const child of Array.from(node.children)) {
      observer.observe(child);
    }

    scheduleMeasure();
    return () => observer.disconnect();
  }, [activeTabId, activeTab?.mode, minimapShown, settings.sidebarOpen]);

  useEffect(() => {
    if (activeTab?.mode !== "preview") {
      setHeadings([]);
      return;
    }

    const root = findRootRef.current;
    if (!root) {
      return;
    }

    const nodes = Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"));
    setHeadings(nodes.map((node) => ({ level: Number(node.tagName[1]), text: node.textContent || "" })));
  }, [activeTab?.content, activeTab?.mode, activeTab?.previewSecurity, activeTabId]);

  // ── tauri events ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!sessionLoaded || !pendingInitialFile) {
      return;
    }

    const file = pendingInitialFile;
    setPendingInitialFile(null);
    void openPreflightFile(file);
  }, [pendingInitialFile, sessionLoaded]);

  useEffect(() => {
    const unlisten = listen<string>("open-file-requested", (event) => void openPath(event.payload));
    return () => void unlisten.then((dispose) => dispose());
  }, [tabs]);

  useEffect(() => {
    const unlisten = listen("close-requested", () => void requestWindowClose());
    return () => void unlisten.then((dispose) => dispose());
  }, [tabs]);

  useEffect(() => {
    function onFocus() {
      void checkActiveFileForExternalChange();
    }

    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [activeTab]);

  useEffect(() => {
    if (!activeTab?.path || activeTab.modifiedMs === null) {
      return;
    }

    const timer = window.setInterval(() => void checkActiveFileForExternalChange(), 1500);
    return () => window.clearInterval(timer);
  }, [activeTab]);

  // ── keyboard ────────────────────────────────────────────────────────────

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const key = shortcutLetter(event);
      const ctrl = event.ctrlKey || event.metaKey;

      if (event.key === "Escape") {
        if (dialog) {
          event.preventDefault();
          resolveDialog("cancel");
        } else if (lightbox) {
          event.preventDefault();
          setLightbox(null);
        } else if (paletteOpen || menuOpen) {
          event.preventDefault();
          setPaletteOpen(false);
          setMenuOpen(false);
        } else if (findOpen) {
          event.preventDefault();
          setFindOpen(false);
        } else if (activeTab?.mode === "edit") {
          event.preventDefault();
          void leaveEditMode();
        }
        return;
      }

      // Ctrl+F is not the only key WebView2 answers with its own find bar. Claim
      // these for the app's: step through matches, Shift reverses.
      if (event.key === "F3" || (ctrl && key === "g")) {
        event.preventDefault();
        if (findOpen) {
          find.goto(event.shiftKey ? -1 : 1);
        } else {
          openFind();
        }
        return;
      }

      if (!ctrl) {
        return;
      }

      if (key === "k") {
        event.preventDefault();
        openPalette();
      } else if (key === "f") {
        event.preventDefault();
        openFind();
      } else if (key === "o") {
        event.preventDefault();
        void openFile();
      } else if (key === "n") {
        event.preventDefault();
        newTab();
      } else if (key === "s") {
        event.preventDefault();
        void (event.shiftKey ? saveAsFile() : saveCurrentFile());
      } else if (key === "e") {
        event.preventDefault();
        void toggleMode();
      } else if (key === "m") {
        event.preventDefault();
        toggleMinimap();
      } else if (key === "w") {
        event.preventDefault();
        if (activeTabId) {
          void closeTab(activeTabId);
        }
      }
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [activeTab, dialog, findOpen, lightbox, menuOpen, paletteOpen, tabs]);

  // The lightbox borrows the Blob URL from the image in the preview. Anything
  // that can unmount that image revokes the URL, so close first.
  useEffect(() => {
    setLightbox(null);
  }, [activeTabId, activeTab?.content, activeTab?.mode, activeTab?.previewSecurity]);

  // ── state helpers ───────────────────────────────────────────────────────

  async function loadInitialState() {
    const session = safeParseJson<{ tabs: PersistedTab[]; activeTabId: string | null }>(
      localStorage.getItem(STORAGE_KEYS.session),
      { tabs: [], activeTabId: null }
    );
    const storedSettings = {
      ...DEFAULT_SETTINGS,
      ...safeParseJson<Partial<Settings>>(localStorage.getItem(STORAGE_KEYS.settings), {})
    };
    const initialFile = await invoke<PreflightFile | null>("get_initial_file");

    let restoredTabs = storedSettings.restoreTabs
      ? session.tabs
          .map(unpackTab)
          .filter(shouldPersistTab)
          .map((tab) => ({
            ...tab,
            previewSecurity: "safe" as PreviewSecurity,
            imageFolder: null,
            remoteAllowed: []
          }))
      : [];
    let restoredActiveTabId = restoredTabs.some((tab) => tab.id === session.activeTabId)
      ? session.activeTabId
      : restoredTabs[0]?.id || null;

    if (initialFile) {
      restoredTabs = restoredTabs.filter((tab) => tab.path !== initialFile.path);
      restoredActiveTabId = restoredTabs.some((tab) => tab.id === restoredActiveTabId)
        ? restoredActiveTabId
        : restoredTabs[0]?.id || null;
      setPendingInitialFile(initialFile);
    }

    setTabs(restoredTabs);
    setActiveTabId(restoredActiveTabId);
    setSessionLoaded(true);
  }

  function showDialog(next: AppDialogState): Promise<DialogActionValue> {
    setMenuOpen(false);
    setPaletteOpen(false);
    setDialog(next);
    return new Promise((resolve) => {
      dialogResolverRef.current = resolve;
    });
  }

  function resolveDialog(value: DialogActionValue) {
    dialogResolverRef.current?.(value);
    dialogResolverRef.current = null;
    setDialog(null);
  }

  function updateActiveTab(patch: Partial<TabState>) {
    if (!activeTabId) {
      return;
    }

    setTabs((current) => current.map((tab) => (tab.id === activeTabId ? { ...tab, ...patch } : tab)));
  }

  function replaceActiveTab(tab: TabState) {
    setTabs((current) => current.map((item) => (item.id === activeTabId ? tab : item)));
    setActiveTabId(tab.id);
  }

  function rememberRecent(file: LoadedFile | RecentFile) {
    setRecentFiles((current) =>
      [{ path: file.path, name: file.name }, ...current.filter((item) => item.path !== file.path)].slice(
        0,
        MAX_RECENT_FILES
      )
    );
  }

  function updateSettings(patch: Partial<Settings>) {
    setSettings((current) => ({ ...current, ...patch }));
  }

  // ── files ───────────────────────────────────────────────────────────────

  async function prepareSpaceForNewTab() {
    if (tabs.length < MAX_OPEN_TABS) {
      return true;
    }

    const oldestTab = tabs[0];
    if (!oldestTab) {
      return false;
    }

    const choice = await showDialog({
      kind: "warn",
      title: t.tabLimitTitle(MAX_OPEN_TABS),
      message: t.tabLimitText,
      actions: [
        { value: "cancel", label: t.cancel },
        { value: "ok", label: t.ok, kind: "primary" }
      ]
    });

    return choice === "ok" ? closeTab(oldestTab.id) : false;
  }

  async function openLoadedFile(loaded: LoadedFile) {
    const existing = tabs.find((tab) => tab.path === loaded.path);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }

    if (!(await prepareSpaceForNewTab())) {
      return;
    }

    const tab = tabFromLoadedFile(loaded);
    setTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
    rememberRecent(loaded);
  }

  async function openPreflightFile(preflight: PreflightFile) {
    const loaded = await confirmPreflightFile(preflight);
    if (loaded) {
      await openLoadedFile(loaded);
    }
  }

  async function confirmPreflightFile(preflight: PreflightFile): Promise<LoadedFile | null> {
    const findings = Object.entries(preflight.findings).filter(([, count]) => count > 0);
    if (findings.length) {
      const choice = await showDialog({
        kind: "warn",
        title: t.riskyTitle,
        message: t.riskyText,
        detail: findings.map(([key, count]) => `${(t[findingLabels[key]] as string) || key}: ${count}`).join("\n"),
        actions: [
          { value: "cancel", label: t.cancel },
          { value: "ok", label: t.openAnyway, kind: "primary" }
        ]
      });

      if (choice !== "ok") {
        await invoke("cancel_markdown_preflight", { token: preflight.token });
        return null;
      }
    }

    return invoke<LoadedFile>("confirm_markdown_preflight", { token: preflight.token });
  }

  async function openPath(path: string) {
    try {
      const preflight = await invoke<PreflightFile>("read_markdown_file", { path });
      await openPreflightFile(preflight);
    } catch {
      setRecentFiles((current) => current.filter((item) => item.path !== path));
    }
  }

  async function openFile() {
    setMenuOpen(false);
    setPaletteOpen(false);
    const preflight = await invoke<PreflightFile | null>("open_markdown_dialog");
    if (preflight) {
      await openPreflightFile(preflight);
    }
  }

  function newTab() {
    setMenuOpen(false);
    setPaletteOpen(false);
    void (async () => {
      if (!(await prepareSpaceForNewTab())) {
        return;
      }

      const tab = createUntitledTab(tabs.filter((item) => !item.path).length + 1);
      setTabs((current) => [...current, tab]);
      setActiveTabId(tab.id);
    })();
  }

  async function closeTab(tabId: string): Promise<boolean> {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) {
      return false;
    }

    if (tab.content !== tab.originalContent) {
      const choice = await showDialog({
        kind: "warn",
        title: t.unsavedTitle,
        message: t.unsavedCloseTab(tab.name),
        actions: [
          { value: "cancel", label: t.cancel },
          { value: "discard", label: t.discard, kind: "danger" },
          { value: "save", label: t.save, kind: "primary" }
        ]
      });

      if (choice === "cancel") {
        return false;
      }

      if (choice === "save" && !(await saveTab(tab))) {
        return false;
      }
    }

    releaseImagePermissions(tab.path);

    setTabs((current) => {
      const index = current.findIndex((item) => item.id === tabId);
      const next = current.filter((item) => item.id !== tabId);
      if (activeTabId === tabId) {
        setActiveTabId(next[index]?.id || next[index - 1]?.id || null);
      }
      return next;
    });

    return true;
  }

  async function saveTab(tab: TabState): Promise<boolean> {
    if (!tab.path) {
      const loaded = await invoke<LoadedFile | null>("save_markdown_dialog", {
        currentPath: null,
        content: tab.content
      });
      if (!loaded) {
        return false;
      }

      setTabs((current) =>
        current.map((item) => (item.id === tab.id ? { ...tabFromLoadedFile(loaded), id: tab.id, mode: tab.mode } : item))
      );
      rememberRecent(loaded);
      return true;
    }

    if (await isChangedOnDisk(tab)) {
      const choice = await showDialog({
        kind: "warn",
        title: t.diskTitle,
        message: t.diskOverwrite(tab.name),
        actions: [
          { value: "cancel", label: t.cancel },
          { value: "overwrite", label: t.overwrite, kind: "primary" }
        ]
      });

      if (choice !== "overwrite") {
        return false;
      }
    }

    const loaded = await invoke<LoadedFile>("write_markdown_file", { path: tab.path, content: tab.content });
    setTabs((current) =>
      current.map((item) => (item.id === tab.id ? { ...tabFromLoadedFile(loaded), id: tab.id, mode: tab.mode } : item))
    );
    rememberRecent(loaded);
    return true;
  }

  async function saveCurrentFile() {
    setMenuOpen(false);
    setPaletteOpen(false);
    if (activeTab) {
      await saveTab(activeTab);
    }
  }

  async function saveAsFile(): Promise<boolean> {
    setMenuOpen(false);
    setPaletteOpen(false);
    if (!activeTab) {
      return false;
    }

    const loaded = await invoke<LoadedFile | null>("save_markdown_dialog", {
      currentPath: activeTab.path,
      content: activeTab.content
    });
    if (!loaded) {
      return false;
    }

    replaceActiveTab({ ...tabFromLoadedFile(loaded), id: activeTab.id, mode: activeTab.mode });
    rememberRecent(loaded);
    return true;
  }

  async function isChangedOnDisk(tab: TabState) {
    if (!tab.path || tab.modifiedMs === null) {
      return false;
    }

    try {
      const metadata = await invoke<FileMetadata>("file_metadata", { path: tab.path });
      return metadata.modifiedMs !== tab.modifiedMs;
    } catch {
      return false;
    }
  }

  async function checkActiveFileForExternalChange() {
    if (!activeTab?.path || activeTab.modifiedMs === null) {
      return;
    }

    let metadata: FileMetadata;
    try {
      metadata = await invoke<FileMetadata>("file_metadata", { path: activeTab.path });
    } catch {
      return;
    }

    if (metadata.modifiedMs === activeTab.modifiedMs) {
      externalChangeRef.current = null;
      return;
    }

    const changeKey = `${activeTab.path}:${metadata.modifiedMs}`;
    if (externalChangeRef.current === changeKey) {
      return;
    }
    externalChangeRef.current = changeKey;

    const choice = await showDialog({
      kind: "warn",
      title: t.diskTitle,
      message: t.diskLoad(activeTab.name),
      actions: [
        { value: "cancel", label: t.cancel },
        { value: "load", label: t.load, kind: "primary" }
      ]
    });

    if (choice !== "load") {
      return;
    }

    const preflight = await invoke<PreflightFile>("read_markdown_file", { path: activeTab.path });
    const loaded = await confirmPreflightFile(preflight);
    if (loaded) {
      replaceActiveTab({ ...tabFromLoadedFile(loaded), id: activeTab.id });
      externalChangeRef.current = null;
    }
  }

  // ── modes, security, links ──────────────────────────────────────────────

  async function toggleMode() {
    if (!activeTab) {
      return;
    }

    setMenuOpen(false);
    setPaletteOpen(false);
    if (activeTab.mode === "preview") {
      updateActiveTab({ mode: "edit" });
      return;
    }

    await leaveEditMode();
  }

  async function leaveEditMode() {
    if (!activeTab) {
      return;
    }

    if (dirty) {
      const choice = await showDialog({
        kind: "warn",
        title: t.unsavedTitle,
        message: t.unsavedLeaveEdit(activeTab.name),
        actions: [
          { value: "cancel", label: t.cancel },
          { value: "discard", label: t.discard, kind: "danger" },
          { value: "save", label: t.save, kind: "primary" }
        ]
      });

      if (choice === "cancel") {
        return;
      }

      if (choice === "save") {
        if (!(await saveTab(activeTab))) {
          return;
        }
      } else {
        updateActiveTab({ content: activeTab.originalContent });
      }
    }

    updateActiveTab({ mode: "preview" });
  }

  /** Dropping a grant never needs permission, and a file that moved away is
   *  still a valid key to forget. */
  function release(command: string, path: string | null) {
    if (path) {
      void invoke(command, { documentPath: path }).catch(() => undefined);
    }
  }

  function releaseImagePermissions(path: string | null) {
    release("clear_image_folder", path);
    release("clear_remote_images", path);
  }

  /**
   * The only thing in PureMD that lets a network connection happen, and it is
   * an act on this document rather than a setting that is remembered. The
   * dialog names the servers before anything is requested, because the cost is
   * paid per server and cannot be taken back.
   */
  async function allowRemoteImages(sources: string[]) {
    if (!activeTab?.path || !sources.length) {
      return;
    }

    const hosts = [...new Set(sources.map(hostOf))];
    const choice = await showDialog({
      kind: "warn",
      title: t.remoteImagesTitle,
      message: t.remoteImagesText(sources.length, hosts.length),
      detail: hosts.join("\n"),
      actions: [
        { value: "cancel", label: t.keepBlocked },
        { value: "load", label: t.load, kind: "primary" }
      ]
    });

    if (choice !== "load") {
      return;
    }

    try {
      const approved = await invoke<string[]>("allow_remote_images", {
        documentPath: activeTab.path,
        sources
      });

      updateActiveTab({ remoteAllowed: approved });
      retryFailedImages();
    } catch (error) {
      // Refusing is a normal outcome — a restored tab has no authorized path
      // until the file is opened again — so it has to be said out loud rather
      // than left as an unhandled rejection in the console.
      await showDialog({
        kind: "danger",
        title: t.imageProblemTitle,
        message: t.remoteImagesRefused,
        detail: String(error),
        actions: [{ value: "ok", label: t.ok, kind: "primary" }]
      });
    }
  }

  async function enableExtendedMode() {
    if (!activeTab) {
      return;
    }

    const choice = await showDialog({
      kind: "shield",
      title: t.extendedModeTitle,
      message: t.extendedModeWarning,
      actions: [
        { value: "cancel", label: t.cancel },
        { value: "enable", label: t.enable, kind: "primary" }
      ]
    });

    if (choice === "enable") {
      updateActiveTab({ previewSecurity: "extended" });
    }
  }

  function setSecurity(next: PreviewSecurity) {
    if (!activeTab || activeTab.previewSecurity === next) {
      return;
    }

    if (next === "safe") {
      releaseImagePermissions(activeTab.path);
      updateActiveTab({ previewSecurity: "safe", imageFolder: null, remoteAllowed: [] });
      retryAllImages();
    } else {
      void enableExtendedMode();
    }
  }

  /** Widens this document to a second image root. The native dialog is the
   *  authorization; the message before it says the whole folder is granted. */
  async function allowImageFolder() {
    if (!activeTab?.path) {
      return;
    }

    const choice = await showDialog({
      kind: "shield",
      title: t.imageFolderTitle,
      message: t.imageFolderText,
      actions: [
        { value: "cancel", label: t.cancel },
        { value: "ok", label: t.chooseFile, kind: "primary" }
      ]
    });

    if (choice !== "ok") {
      return;
    }

    try {
      const folder = await invoke<string | null>("choose_image_folder", {
        documentPath: activeTab.path
      });

      if (folder) {
        updateActiveTab({ imageFolder: folder });
        retryFailedImages();
      }
    } catch (error) {
      await showDialog({
        kind: "danger",
        title: t.imageProblemTitle,
        message: t.remoteImagesRefused,
        detail: String(error),
        actions: [{ value: "ok", label: t.ok, kind: "primary" }]
      });
    }
  }

  function revokeImageFolder() {
    if (!activeTab) {
      return;
    }

    release("clear_image_folder", activeTab.path);
    updateActiveTab({ imageFolder: null });
    retryAllImages();
  }

  function revokeRemoteImages() {
    if (!activeTab) {
      return;
    }

    release("clear_remote_images", activeTab.path);
    updateActiveTab({ remoteAllowed: [] });
    retryAllImages();
  }

  async function showImageNotice(source: string, failure: ImageFailure) {
    if (failure === "blocked") {
      const choice = await showDialog({
        kind: "danger",
        title: t.blockedImageTitle,
        message: t.blockedImageText,
        detail: source,
        actions: [
          { value: "cancel", label: t.keepBlocked },
          { value: "enable", label: t.enableExtendedMode, kind: "primary" }
        ]
      });

      if (choice === "enable") {
        await enableExtendedMode();
      }
      return;
    }

    if (failure === "outsideFolder") {
      await allowImageFolder();
      return;
    }

    if (failure === "remote") {
      await allowRemoteImages([source]);
      return;
    }

    // A restored tab has no authorized path, so nothing on disk can be read for
    // it. The native dialog is the only way to grant that, and picking the same
    // file again lands back on this very tab — `openLoadedFile` reuses it.
    if (failure === "unauthorized") {
      await openFile();
      retryFailedImages();
      return;
    }

    await showDialog({
      kind: "danger",
      title: t.imageProblemTitle,
      message: imageNotes[failure],
      detail: source,
      actions: [{ value: "ok", label: t.ok, kind: "primary" }]
    });
  }

  async function openExternalLink(href: string) {
    const choice = await showDialog({
      kind: "link",
      title: t.openExternalTitle,
      message: t.openExternalText,
      detail: href,
      actions: [
        { value: "cancel", label: t.cancel },
        { value: "ok", label: t.openLink, kind: "primary" }
      ]
    });

    if (choice === "ok") {
      await invoke("open_external_url", { url: href });
    }
  }

  function showBlockedLink() {
    void showDialog({
      kind: "danger",
      title: t.blockedLinkTitle,
      message: t.blockedLinkText,
      actions: [{ value: "ok", label: t.ok, kind: "primary" }]
    });
  }

  // ── window ──────────────────────────────────────────────────────────────

  async function requestWindowClose() {
    if (tabs.some((tab) => tab.content !== tab.originalContent)) {
      const choice = await showDialog({
        kind: "warn",
        title: t.unsavedTitle,
        message: t.unsavedExit,
        actions: [
          { value: "cancel", label: t.cancel },
          { value: "discard", label: t.closeAnyway, kind: "danger" }
        ]
      });

      if (choice !== "discard") {
        return;
      }
    }

    await invoke("close_main_window");
  }

  function startWindowDrag(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || event.detail > 1) {
      return;
    }

    void invoke("start_window_drag");
  }

  // ── overlays ────────────────────────────────────────────────────────────

  function openFind() {
    if (onHome) {
      return;
    }

    setMenuOpen(false);
    setPaletteOpen(false);
    setFindOpen(true);
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }

  function openPalette() {
    setMenuOpen(false);
    setFindOpen(false);
    setPaletteQuery("");
    setPaletteIndex(0);
    setPaletteOpen(true);
    requestAnimationFrame(() => paletteInputRef.current?.focus());
  }

  function toggleMinimap() {
    setMenuOpen(false);
    setPaletteOpen(false);
    updateSettings({ minimapOn: !settings.minimapOn });
  }

  // ── document navigation ─────────────────────────────────────────────────

  function scrollToHeading(index: number) {
    const container = scrollRef.current;
    const target = findRootRef.current?.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")[index];
    if (!container || !target) {
      return;
    }

    const box = target.getBoundingClientRect();
    const frame = container.getBoundingClientRect();
    container.scrollTo({ top: Math.max(0, container.scrollTop + (box.top - frame.top) - 28), behavior: "smooth" });
  }

  function scrubMinimap(ratio: number) {
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    // the pointer grabs the viewport slab by its middle
    const visible = container.clientHeight / container.scrollHeight;
    const top = Math.max(0, Math.min(1 - visible, ratio - visible / 2));
    container.scrollTo({ top: top * container.scrollHeight });
  }

  // ── tab strip drag / wheel ──────────────────────────────────────────────

  function scrollTabsWithWheel(event: ReactWheelEvent<HTMLElement>) {
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (delta === 0 || !tabsRowRef.current) {
      return;
    }

    tabsRowRef.current.scrollLeft += delta;
  }

  function startTabsDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const node = tabsRowRef.current;
    if (event.button !== 0 || !node) {
      return;
    }

    tabsDragRef.current = {
      active: true,
      moved: false,
      captured: false,
      startScrollLeft: node.scrollLeft,
      startX: event.clientX
    };
  }

  function dragTabs(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = tabsDragRef.current;
    const node = tabsRowRef.current;
    if (!drag.active || !node) {
      return;
    }

    const distance = event.clientX - drag.startX;
    if (Math.abs(distance) > 3) {
      drag.moved = true;
      if (!drag.captured) {
        node.setPointerCapture(event.pointerId);
        drag.captured = true;
      }
    }

    node.scrollLeft = drag.startScrollLeft - distance;
  }

  function stopTabsDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const node = tabsRowRef.current;
    if (node?.hasPointerCapture(event.pointerId)) {
      node.releasePointerCapture(event.pointerId);
    }
    tabsDragRef.current.active = false;
  }

  function activateTab(tabId: string) {
    if (tabsDragRef.current.moved) {
      tabsDragRef.current.moved = false;
      return;
    }

    setActiveTabId(tabId);
  }

  // ── command palette ─────────────────────────────────────────────────────

  type Command = { id: string; label: string; shortcut: string; icon: ReactNode; run: () => void };

  const commands: Command[] = [
    { id: "open", label: t.open, shortcut: "Ctrl+O", icon: <FolderIcon />, run: () => void openFile() },
    { id: "new", label: t.newFile, shortcut: "Ctrl+N", icon: <PlusIcon />, run: newTab },
    { id: "save", label: t.save, shortcut: "Ctrl+S", icon: <SaveIcon />, run: () => void saveCurrentFile() },
    { id: "saveAs", label: t.saveAs, shortcut: "Ctrl+⇧+S", icon: <SaveIcon />, run: () => void saveAsFile() },
    {
      id: "mode",
      label: activeTab?.mode === "preview" ? t.switchToCode : t.backToPreview,
      shortcut: "Ctrl+E",
      icon: <PencilIcon />,
      run: () => void toggleMode()
    },
    { id: "find", label: t.findInDocument, shortcut: "Ctrl+F", icon: <SearchIcon />, run: openFind },
    {
      id: "minimap",
      label: settings.minimapOn ? t.hideMinimap : t.showMinimap,
      shortcut: "Ctrl+M",
      icon: <PanelIcon size={13} />,
      run: toggleMinimap
    }
  ];

  const paletteCommands = commands.filter((command) =>
    command.label.toLocaleLowerCase().includes(paletteQuery.trim().toLocaleLowerCase())
  );

  function onPaletteKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setPaletteIndex((current) => (paletteCommands.length ? (current + 1) % paletteCommands.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setPaletteIndex((current) =>
        paletteCommands.length ? (current - 1 + paletteCommands.length) % paletteCommands.length : 0
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      paletteCommands[Math.min(paletteIndex, paletteCommands.length - 1)]?.run();
    }
  }

  // ── layout reserves ─────────────────────────────────────────────────────

  const sidebarWidth = !settings.sidebarOpen ? 0 : activeTab?.mode === "edit" ? 280 : 236;
  const minimapLane = isEmptyDocument ? 24 : settings.minimapOn ? 172 : 54;
  const rightReserve = Math.max(sidebarWidth, minimapLane);
  const leftReserve = Math.max(0, minimapLane - sidebarWidth);

  // ── render ──────────────────────────────────────────────────────────────

  return (
    <div className="pm-app" onContextMenu={(event) => event.preventDefault()}>
      <header className="pm-titlebar" onPointerDown={startWindowDrag}>
        <button
          type="button"
          className={menuOpen ? "pm-icon-btn is-active" : "pm-icon-btn"}
          title={t.menu}
          aria-label={t.menu}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            setMenuOpen((value) => !value);
            setPaletteOpen(false);
          }}
        >
          <MenuIcon />
        </button>

        <div
          className="pm-tabs"
          ref={tabsRowRef}
          onPointerDownCapture={(event) => {
            event.stopPropagation();
            startTabsDrag(event);
          }}
          onPointerMove={dragTabs}
          onPointerUp={stopTabsDrag}
          onPointerCancel={stopTabsDrag}
          onWheelCapture={scrollTabsWithWheel}
        >
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const isDirty = tab.content !== tab.originalContent;
            const showClose = isActive && hoveredTabId === tab.id;

            return (
              <div
                key={tab.id}
                className={`pm-tab${isActive ? " is-active" : ""}${tab.path ? "" : " is-untitled"}`}
                title={tab.path || tab.name}
                onMouseEnter={() => setHoveredTabId(tab.id)}
                onMouseLeave={() => setHoveredTabId((current) => (current === tab.id ? null : current))}
              >
                <button type="button" className="pm-tab-main" onClick={() => activateTab(tab.id)}>
                  <FileIcon />
                  <span>{tab.name}</span>
                </button>
                <span
                  className={`pm-tab-slot${isDirty ? " is-dirty" : ""}${hoveredTabId === tab.id ? " is-hovered" : ""}`}
                >
                  {isDirty && <span className="pm-tab-dot" title={t.unsavedChanges} />}
                  <button
                    type="button"
                    className={showClose ? "pm-tab-close is-shown" : "pm-tab-close"}
                    title={t.closeTab}
                    aria-label={t.closeTab}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      void closeTab(tab.id);
                    }}
                  >
                    ×
                  </button>
                </span>
              </div>
            );
          })}
          <button
            type="button"
            className="pm-icon-btn pm-tab-add"
            title={t.newDocument}
            aria-label={t.newDocument}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={newTab}
          >
            +
          </button>
        </div>

        <div className="pm-drag" onDoubleClick={() => void invoke("toggle_maximize_main_window")} />

        <div className="pm-winbtns" onPointerDown={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="pm-winbtn"
            title={t.minimize}
            aria-label={t.minimize}
            onClick={() => void invoke("minimize_main_window")}
          >
            <WinMinimizeIcon />
          </button>
          <button
            type="button"
            className="pm-winbtn"
            title={maximized ? t.restore : t.maximize}
            aria-label={maximized ? t.restore : t.maximize}
            onClick={() => void invoke("toggle_maximize_main_window")}
          >
            {maximized ? <WinRestoreIcon /> : <WinMaximizeIcon />}
          </button>
          <button
            type="button"
            className="pm-winbtn is-close"
            title={t.close}
            aria-label={t.close}
            onClick={() => void requestWindowClose()}
          >
            <WinCloseIcon />
          </button>
        </div>
      </header>

      {menuOpen && (
        <>
          <div className="pm-catcher" onClick={() => setMenuOpen(false)} />
          <nav className="pm-menu pm-s">
            <button type="button" className="pm-menu-row" onClick={() => void openFile()}>
              <span>{t.open}</span>
              <span className="pm-chip">Ctrl O</span>
            </button>
            <button type="button" className="pm-menu-row" onClick={newTab}>
              <span>{t.newFile}</span>
              <span className="pm-chip">Ctrl N</span>
            </button>
            <button type="button" className="pm-menu-row" disabled={onHome} onClick={() => void saveCurrentFile()}>
              <span>{t.save}</span>
              <span className="pm-chip">Ctrl S</span>
            </button>
            <button type="button" className="pm-menu-row" disabled={onHome} onClick={() => void saveAsFile()}>
              <span>{t.saveAs}</span>
              <span className="pm-chip">Ctrl ⇧ S</span>
            </button>
            <button type="button" className="pm-menu-row" disabled={onHome} onClick={openFind}>
              <span>{t.findInDocument}</span>
              <span className="pm-chip">Ctrl F</span>
            </button>
            <button type="button" className="pm-menu-row" onClick={toggleMinimap}>
              <span>{settings.minimapOn ? t.hideMinimap : t.showMinimap}</span>
              <span className="pm-chip">Ctrl M</span>
            </button>

            <div className="pm-divider" />
            <div className="pm-section-label">{t.previewSecurity}</div>
            <div className="pm-menu-block">
              <h3>{extended ? t.extendedMode : t.safeMode}</h3>
              <p>{extended ? t.extendedModeText : t.safeModeText}</p>
              <div className="pm-seg">
                <button
                  type="button"
                  className={!extended ? "is-active" : ""}
                  disabled={onHome}
                  onClick={() => setSecurity("safe")}
                >
                  {t.safeMode}
                </button>
                <button
                  type="button"
                  className={extended ? "is-active" : ""}
                  disabled={onHome}
                  onClick={() => setSecurity("extended")}
                >
                  {t.extendedMode}
                </button>
              </div>
              {extended && activeTab?.imageFolder && (
                <div className="pm-folder-line">
                  <FolderIcon size={14} />
                  <span className="pm-perm">
                    <span className="pm-section-label">{t.imageFolder}</span>
                    <span className="pm-badge-granted">{t.granted}</span>
                  </span>
                  {/* the tail of a path is the informative end */}
                  <code className="is-path" title={activeTab.imageFolder}>
                    {activeTab.imageFolder}
                  </code>
                  <button type="button" className="pm-link-btn" onClick={revokeImageFolder}>
                    {t.revoke}
                  </button>
                </div>
              )}
              {extended && activeTab && activeTab.remoteAllowed.length > 0 && (
                <div className="pm-folder-line">
                  <CloudDownloadIcon size={14} />
                  <span className="pm-perm">
                    <span className="pm-section-label">{t.remoteImages}</span>
                    <span className="pm-badge-granted">{t.granted}</span>
                  </span>
                  <code>{[...new Set(activeTab.remoteAllowed.map(hostOf))].join(", ")}</code>
                  <button type="button" className="pm-link-btn" onClick={revokeRemoteImages}>
                    {t.revoke}
                  </button>
                </div>
              )}
            </div>

            <div className="pm-divider" />
            <div className="pm-menu-line">
              <span>{t.language}</span>
              <div className="pm-seg is-lang">
                {LANGUAGES.map((code) => (
                  <button
                    key={code}
                    type="button"
                    className={language === code ? "is-active" : ""}
                    onClick={() => setLanguage(code)}
                  >
                    {code.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <div className="pm-menu-line">
              <span>{t.restoreTabs}</span>
              <button
                type="button"
                className={settings.restoreTabs ? "pm-toggle is-on" : "pm-toggle"}
                role="switch"
                aria-checked={settings.restoreTabs}
                aria-label={t.restoreTabs}
                onClick={() => updateSettings({ restoreTabs: !settings.restoreTabs })}
              >
                <span />
              </button>
            </div>
            <div className="pm-menu-line">
              <span>{t.minimapOpacity}</span>
              <input
                className="pm-range"
                type="range"
                min={0.1}
                max={1}
                step={0.02}
                value={settings.minimapGhostOpacity}
                aria-label={t.minimapOpacity}
                onChange={(event) => updateSettings({ minimapGhostOpacity: Number(event.currentTarget.value) })}
              />
            </div>

            <div className="pm-divider" />
            <div className="pm-menu-foot">
              {t.appName} {__APP_VERSION__} · by{" "}
              <button type="button" onClick={() => void openExternalLink("https://quetza.one")}>
                quetza
              </button>
            </div>
          </nav>
        </>
      )}

      {paletteOpen && (
        <>
          <div className="pm-catcher is-scrim" onClick={() => setPaletteOpen(false)} />
          <nav className="pm-palette">
            <div className="pm-palette-search">
              <SearchIcon />
              <input
                ref={paletteInputRef}
                value={paletteQuery}
                placeholder={t.typeCommand}
                spellCheck={false}
                onChange={(event) => {
                  setPaletteQuery(event.currentTarget.value);
                  setPaletteIndex(0);
                }}
                onKeyDown={onPaletteKeyDown}
              />
              <span className="pm-esc">esc</span>
            </div>
            <div className="pm-palette-body pm-s">
              <div className="pm-palette-label">{t.commands}</div>
              {paletteCommands.map((command, order) => (
                <button
                  key={command.id}
                  type="button"
                  className={order === paletteIndex ? "pm-palette-row is-selected" : "pm-palette-row"}
                  onMouseEnter={() => setPaletteIndex(order)}
                  onClick={command.run}
                >
                  {command.icon}
                  <span>{command.label}</span>
                  <kbd>{command.shortcut}</kbd>
                </button>
              ))}
              {!paletteCommands.length && <div className="pm-palette-empty">{t.noCommands}</div>}
              <div className="pm-divider" />
              <div className="pm-palette-inline">
                <ShieldIcon />
                <span>{t.extendedMode}</span>
                <button
                  type="button"
                  className={extended ? "pm-toggle is-amber is-on" : "pm-toggle is-amber"}
                  role="switch"
                  aria-checked={extended}
                  aria-label={t.extendedMode}
                  disabled={onHome}
                  onClick={() => setSecurity(extended ? "safe" : "extended")}
                >
                  <span />
                </button>
              </div>
            </div>
            <div className="pm-palette-foot">
              <span>{t.paletteHint}</span>
              <span>
                {t.appName} {__APP_VERSION__} · by quetza
              </span>
            </div>
          </nav>
        </>
      )}

      {findOpen && activeTab && (
        <div className="pm-find" style={{ right: minimapShown ? 180 : 26 }}>
          <SearchIcon size={12} />
          <input
            ref={findInputRef}
            value={findQuery}
            placeholder={t.findInDocument}
            aria-label={t.findInDocument}
            spellCheck={false}
            onChange={(event) => setFindQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                find.goto(event.shiftKey ? -1 : 1);
              }
            }}
          />
          <span className={findQuery.trim() && !find.count ? "pm-find-count is-empty" : "pm-find-count"}>
            {findQuery.trim() ? `${find.count ? find.index + 1 : 0}/${find.count}` : ""}
          </span>
          <button type="button" className="pm-find-btn" title={t.previousMatch} onClick={() => find.goto(-1)}>
            ↑
          </button>
          <button type="button" className="pm-find-btn" title={t.nextMatch} onClick={() => find.goto(1)}>
            ↓
          </button>
          <div className="pm-find-sep" />
          <button
            type="button"
            className="pm-find-btn is-close"
            title={t.closeSearch}
            onClick={() => setFindOpen(false)}
          >
            ×
          </button>
        </div>
      )}

      {!activeTab ? (
        <div className="pm-home pm-s">
          <div className="pm-home-inner">
            <div className="pm-home-head">
              <div className="pm-tile-glyph">
                <FileLinesIcon />
              </div>
              <div>
                <h1>{t.homeTitle}</h1>
                <p>{t.homeLede}</p>
              </div>
              <div className="pm-home-buttons">
                <button type="button" className="pm-btn is-primary" onClick={() => void openFile()}>
                  <FolderIcon />
                  {t.openFile}
                  <kbd>Ctrl O</kbd>
                </button>
                <button type="button" className="pm-btn" onClick={newTab}>
                  <PlusIcon />
                  {t.newFile}
                  <kbd>Ctrl N</kbd>
                </button>
              </div>
            </div>

            <div className="pm-recent-head">
              <span>{t.recentFiles}</span>
              {recentFiles.length > 0 && (
                <button type="button" className="pm-text-btn" onClick={() => setRecentFiles([])}>
                  {t.clear}
                </button>
              )}
            </div>

            {recentFiles.length ? (
              <div className="pm-recent-grid">
                {recentFiles.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    className="pm-recent-tile"
                    title={file.path}
                    onClick={() => void openPath(file.path)}
                  >
                    <FileIcon size={15} />
                    <span>
                      <span className="pm-recent-name">{file.name}</span>
                      <span className="pm-recent-path">{file.path}</span>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="pm-recent-empty">{t.noRecents}</div>
            )}
          </div>
        </div>
      ) : (
        <div className="pm-doc">
          {settings.sidebarOpen && (
            <aside
              className={activeTab.mode === "edit" ? "pm-sidebar is-guide pm-s" : "pm-sidebar pm-s"}
              aria-label={activeTab.mode === "edit" ? t.markdownGuide : t.onThisPage}
            >
              {activeTab.mode === "edit" ? (
                <MarkdownGuide t={t} />
              ) : (
                <Outline headings={headings} emptyText={t.outlineEmpty} onSelect={scrollToHeading} />
              )}
            </aside>
          )}

          <div className="pm-lane">
            <div className="pm-scroll pm-s" ref={scrollRef} onScroll={scheduleMeasure}>
              <div className="pm-lane-inner">
                <div className="pm-mirror" aria-hidden="true" style={{ flexBasis: leftReserve }} />

                <section className="pm-card">
                  <div className="pm-toolbar">
                    <button
                      type="button"
                      className={settings.sidebarOpen ? "pm-sb-toggle is-active" : "pm-sb-toggle"}
                      title={activeTab.mode === "edit" ? t.markdownGuide : t.onThisPage}
                      aria-pressed={settings.sidebarOpen}
                      onClick={() => updateSettings({ sidebarOpen: !settings.sidebarOpen })}
                    >
                      <PanelIcon />
                    </button>
                    <div className="pm-toolbar-sep" />

                    <div className={activeTab.mode === "preview" ? "pm-mode is-active" : "pm-mode"}>
                      <button type="button" onClick={() => activeTab.mode === "edit" && void toggleMode()}>
                        <EyeIcon />
                        <span>{t.preview}</span>
                      </button>
                      <i aria-hidden="true" />
                    </div>
                    <div className={activeTab.mode === "edit" ? "pm-mode is-active" : "pm-mode"}>
                      <button type="button" onClick={() => activeTab.mode === "preview" && void toggleMode()}>
                        <ChevronsIcon />
                        <span>{t.code}</span>
                      </button>
                      <i aria-hidden="true" />
                    </div>

                    <div className="pm-toolbar-spacer" />
                    {pendingRemote.length > 0 && (
                      <button
                        type="button"
                        className="pm-remote-btn"
                        title={[...new Set(pendingRemote.map(hostOf))].join(", ")}
                        onClick={() => void allowRemoteImages(pendingRemote)}
                      >
                        <DownloadIcon />
                        <span>{t.loadRemoteImages(pendingRemote.length)}</span>
                      </button>
                    )}
                    <span className="pm-words">{wordCount}</span>
                    <button
                      type="button"
                      className={extended ? "pm-sec-chip is-extended" : "pm-sec-chip"}
                      title={t.previewSecurity}
                      onClick={() => setSecurity(extended ? "safe" : "extended")}
                    >
                      <ShieldIcon size={10} />
                      <span>{extended ? t.extendedMode : t.safeMode}</span>
                    </button>
                  </div>

                  <div ref={findRootRef}>
                    {activeTab.mode === "preview" ? (
                      isEmptyDocument ? (
                        <div className="pm-empty-preview">
                          <div className="pm-tile-glyph">
                            <FileIcon size={17} />
                          </div>
                          <div className="pm-empty-title">{t.nothingToPreview}</div>
                          <div className="pm-empty-text">{t.nothingToPreviewText}</div>
                          <button type="button" className="pm-btn" onClick={() => void toggleMode()}>
                            {t.startWriting}
                            <kbd>Ctrl E</kbd>
                          </button>
                        </div>
                      ) : (
                        <MarkdownPreview
                          content={activeTab.content}
                          documentPath={activeTab.path}
                          extended={extended}
                          remoteAllowed={activeTab.remoteAllowed}
                          notes={imageNotes}
                          onBlockedLink={onBlockedLink}
                          onOpenLink={onOpenLink}
                          onImageNotice={onImageNotice}
                          onOpenImage={setLightbox}
                        />
                      )
                    ) : (
                      <MarkdownEditor
                        value={activeTab.content}
                        t={t}
                        onChange={(content) => updateActiveTab({ content })}
                        onOpenGuide={() => updateSettings({ sidebarOpen: true })}
                      />
                    )}
                  </div>
                </section>

                <div
                  className="pm-mirror"
                  aria-hidden="true"
                  style={{ flexBasis: rightReserve, minWidth: minimapLane }}
                />
              </div>
            </div>

            {minimapShown && (
              <Minimap
                content={activeTab.content}
                viewportTop={viewport.top}
                viewportHeight={viewport.height}
                hits={findQuery.trim().length >= MINIMAP_TICK_MIN_QUERY ? find.hits : []}
                hitIndex={find.index}
                ghostOpacity={settings.minimapGhostOpacity}
                windowHeight={windowHeight}
                title={t.findInDocument}
                onScrub={scrubMinimap}
              />
            )}
          </div>
        </div>
      )}

      {lightbox && (
        <div className="pm-lightbox" role="dialog" aria-modal="true" onClick={() => setLightbox(null)}>
          <button
            type="button"
            className="pm-lightbox-close"
            aria-label={t.closeImage}
            onClick={() => setLightbox(null)}
          >
            <WinCloseIcon />
          </button>
          <img
            src={lightbox.url}
            alt={lightbox.alt}
            title={`${lightbox.source} · ${lightbox.width} × ${lightbox.height} — ${t.clickToClose}`}
          />
        </div>
      )}

      {dialog && (
        <>
          <div className="pm-dialog-scrim" onClick={() => resolveDialog("cancel")} />
          <section className="pm-dialog" role="dialog" aria-modal="true" aria-labelledby="pm-dialog-title">
            <div className="pm-dialog-head">
              <span className={`pm-dialog-badge is-${dialog.kind}`} aria-hidden="true">
                {dialog.kind === "shield" ? <ShieldIcon /> : dialog.kind === "link" ? <LinkIcon /> : <WarningIcon />}
              </span>
              <div>
                <h2 id="pm-dialog-title">{dialog.title}</h2>
                <p>{dialog.message}</p>
              </div>
            </div>
            {dialog.detail && <code>{dialog.detail}</code>}
            <div className="pm-dialog-actions">
              {dialog.actions.map((action) => (
                <button
                  key={action.value}
                  type="button"
                  className={action.kind === "primary" ? "is-primary" : action.kind === "danger" ? "is-danger" : ""}
                  onClick={() => resolveDialog(action.value)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
