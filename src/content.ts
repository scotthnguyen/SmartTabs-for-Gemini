import { parseConversation, observeConversation, getScrollContainer, type Section, type AttachmentCache } from "./parser";
import { renderSidebar, resetSidebarState, disconnectNavTracking } from "./sidebar";

// Minimal chrome.storage types — avoids pulling in the full @types/chrome package
declare const chrome: {
  storage: {
    local: {
      get(key: string, callback: (result: Record<string, unknown>) => void): void;
      set(items: Record<string, unknown>): void;
    };
  };
};

console.log("[SmartTabs] content script loaded", window.location.href);


const STORAGE_KEY = "smart-tabs-bookmarks-v2";
const ATTACHMENT_KEY_PREFIX = "smarttabs-attachments-";
const SENTINEL_ID = "smarttabs-root";

// Keyed by chat UUID (not full pathname)
let currentChatId = "";
let autoTabsEnabled = true;
let conversationObserver: MutationObserver | null = null;
let initGeneration = 0;
let attachmentCache: AttachmentCache = {};

const sectionMap = new Map<string, Section>();
const removedKeys = new Set<string>();

type StoredBookmark = Omit<Section, "element">;

function getKey(section: Section): string {
  // Auto sections use stable turnId so virtual-scroll index shifts don't create duplicates.
  if (section.type !== "bookmark") return section.turnId || section.id;
  return section.id || section.turnId || section.rawText.toLowerCase();
}

// Returns the conversation ID from /app/<id>, or null if not on a conversation page.
function getChatId(): string | null {
  return window.location.pathname.match(/\/app\/([^/]+)/)?.[1] ?? null;
}

function isInChat(): boolean {
  return /\/app\/[^/]+/.test(window.location.pathname);
}

function simpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function removeSidebarFromPage() {
  disconnectNavTracking();
  document.getElementById("smart-tabs-sidebar")?.remove();
  document.getElementById("smart-tabs-collapsed")?.remove();
  document.getElementById(SENTINEL_ID)?.remove();
}

function getStoredBookmarks(): Promise<Record<string, StoredBookmark[]>> {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      const value = result[STORAGE_KEY];
      resolve(typeof value === "object" && value !== null ? (value as Record<string, StoredBookmark[]>) : {});
    });
  });
}

function getAttachmentStorageKey(): string {
  return `${ATTACHMENT_KEY_PREFIX}${currentChatId}`;
}

function loadAttachmentCache(): Promise<void> {
  const key = getAttachmentStorageKey();
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => {
      const value = result[key];
      attachmentCache =
        typeof value === "object" && value !== null
          ? (value as AttachmentCache)
          : {};
      resolve();
    });
  });
}

function saveAttachmentCache(updated: AttachmentCache): void {
  attachmentCache = updated;
  chrome.storage.local.set({ [getAttachmentStorageKey()]: updated });
}

async function saveBookmarksForCurrentChat(): Promise<void> {
  if (!currentChatId) return;

  const allBookmarks = await getStoredBookmarks();
  const bookmarks: StoredBookmark[] = Array.from(sectionMap.values())
    .filter((section) => section.type === "bookmark")
    .map(({ element, ...rest }) => rest);

  allBookmarks[currentChatId] = bookmarks;
  chrome.storage.local.set({ [STORAGE_KEY]: allBookmarks });
}

async function loadBookmarksForCurrentChat(): Promise<void> {
  const allBookmarks = await getStoredBookmarks();
  const bookmarks = allBookmarks[currentChatId] || [];

  bookmarks.forEach((bookmark) => {
    const restored: Section = { ...bookmark, element: document.body };
    sectionMap.set(getKey(restored), restored);
  });
}

async function resetForNewChat(): Promise<void> {
  sectionMap.clear();
  removedKeys.clear();
  attachmentCache = {};
  resetSidebarState();
  await Promise.all([loadBookmarksForCurrentChat(), loadAttachmentCache()]);
}

function getOrderedSections(): Section[] {
  return Array.from(sectionMap.values())
    .filter((section) => !removedKeys.has(getKey(section)))
    .filter((section) => autoTabsEnabled || section.type === "bookmark")
    .sort((a, b) => {
      if (a.type === "bookmark" && b.type !== "bookmark") return -1;
      if (a.type !== "bookmark" && b.type === "bookmark") return 1;
      if (a.type === "bookmark" && b.type === "bookmark") return b.domOrder - a.domOrder;
      return a.domOrder - b.domOrder;
    });
}

function renderCurrentSidebar() {
  const ordered = getOrderedSections();
  renderSidebar(ordered, {
    autoTabsEnabled,
    onRemoveTab: removeTab,
    onRenameTab: renameTab,
    onToggleHidden: () => {},
    onToggleAutoTabs: toggleAutoTabs,
    onCreateBookmark: createLocationBookmark,
  });
}

function parseAndMerge() {
  const { sections, updatedCache } = parseConversation(attachmentCache);
  saveAttachmentCache(updatedCache);
  mergeSections(sections);
}

function mergeSections(newSections: Section[]) {
  const newKeys = newSections.map(getKey);
  const newKeySet = new Set(newKeys);

  let changed = false;

  // Remove stale auto sections — handles the case where a streaming message
  // initially gets a fallback turnId then is re-parsed with the real hex ID.
  for (const [key, section] of sectionMap) {
    if (section.type !== "bookmark" && !removedKeys.has(key) && !newKeySet.has(key)) {
      sectionMap.delete(key);
      changed = true;
    }
  }

  // Detect additions
  if (!changed) changed = newKeys.some(k => !sectionMap.has(k));

  newSections.forEach((section) => {
    const key = getKey(section);
    const existing = sectionMap.get(key);
    // Spread new section (picks up updated domOrder/element) but keep user-set title.
    sectionMap.set(key, existing ? { ...section, title: existing.title } : section);
  });

  // Only re-render when conversation content actually changed — not for overlays,
  // image viewers, PDFs, thinking-mode expansions, or other non-section DOM noise.
  if (changed) renderCurrentSidebar();
}

function removeTab(section: Section) {
  removedKeys.add(getKey(section));

  if (section.type === "bookmark") {
    sectionMap.delete(getKey(section));
    void saveBookmarksForCurrentChat();
  }

  renderCurrentSidebar();
}

function renameTab(section: Section, newTitle: string) {
  const key = getKey(section);
  const existing = sectionMap.get(key);
  if (!existing) return;

  const finalTitle =
    existing.type === "bookmark" && !newTitle.startsWith("★ ")
      ? `★ ${newTitle}`
      : newTitle;

  sectionMap.set(key, { ...existing, title: finalTitle });

  if (existing.type === "bookmark") {
    void saveBookmarksForCurrentChat();
  }

  renderCurrentSidebar();
}

function toggleAutoTabs() {
  autoTabsEnabled = !autoTabsEnabled;
  renderCurrentSidebar();
}

function createLocationBookmark(section: Section, name: string) {
  const contextText = (
    section.contextText ||
    section.element?.textContent ||
    section.rawText ||
    ""
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1500);

  const bookmark: Section = {
    ...section,
    id: `bookmark-${Date.now()}-${simpleHash(section.id)}`,
    title: `★ ${name}`,
    contextText,
    domOrder: Date.now(),
    type: "bookmark",
  };

  sectionMap.set(getKey(bookmark), bookmark);
  void saveBookmarksForCurrentChat();
  renderCurrentSidebar();
}

// Scrolls to the top of the chat container and waits for lazy-loaded messages
// to finish rendering (scroll height stabilizes). This guarantees that
// querySelectorAll order === chronological order before the first parse.
async function scrollToTopAndLoad(scrollContainer: Element): Promise<void> {
  return new Promise((resolve) => {
    let lastHeight = 0;
    let iterations = 0;
    const MAX_ITERATIONS = 20; // cap at ~12 s for very long chats
    const interval = setInterval(() => {
      scrollContainer.scrollTop = 0;
      const newHeight = scrollContainer.scrollHeight;
      if (newHeight === lastHeight || ++iterations >= MAX_ITERATIONS) {
        clearInterval(interval);
        setTimeout(resolve, 500);
      }
      lastHeight = newHeight;
    }, 600);
  });
}

// Gemini's Angular router does not reliably fire pushState or popstate events,
// so we poll instead. 500ms is imperceptible but catches all navigations.
let lastPathname = window.location.pathname;

function startPollingRouteChanges() {
  window.setInterval(() => {
    const current = window.location.pathname;
    if (current !== lastPathname) {
      lastPathname = current;
      handleRouteChange();
    }
  }, 500);
}

function handleRouteChange() {
  // 1. Disconnect conversation observer
  conversationObserver?.disconnect();
  conversationObserver = null;
  // 2. Disconnect nav observer
  disconnectNavTracking();
  // 3. Remove sidebar DOM
  removeSidebarFromPage();
  // 4. Re-init after Angular router settles
  const gen = ++initGeneration;
  window.setTimeout(() => {
    if (gen === initGeneration) void init();
  }, 400);
}

async function init(): Promise<void> {
  // Prevent double-injection: sentinel is removed by removeSidebarFromPage()
  if (document.getElementById(SENTINEL_ID)) {
    return;
  }

  const sentinel = document.createElement("div");
  sentinel.id = SENTINEL_ID;
  sentinel.style.display = "none";
  document.body.appendChild(sentinel);

  const newChatId = getChatId();

  // Not on a /chat/<uuid> page — ensure sidebar is gone and bail
  if (!isInChat() || !newChatId) {
    removeSidebarFromPage();
    return;
  }

  if (newChatId !== currentChatId) {
    currentChatId = newChatId;
    await resetForNewChat();
  }

  // Scroll to top so all messages load into the DOM in document (chronological) order
  // before we parse. Without this, virtual scrolling delivers messages in random batches.
  const scrollContainer = getScrollContainer();
  if (scrollContainer) {
    await scrollToTopAndLoad(scrollContainer);
  }

  parseAndMerge();

  conversationObserver = observeConversation(parseAndMerge);
}

// Gemini is an Angular SPA — the scroll container may not exist at document_idle.
// Only wait for it when we're already on a conversation page; on /app and other
// pages there is no scroll container and we'd hang until timeout.
function waitForScrollContainer(callback: () => void, timeoutMs = 10000) {
  const start = Date.now();
  function poll() {
    if (getScrollContainer()) {
      callback();
    } else if (Date.now() - start < timeoutMs) {
      window.setTimeout(poll, 200);
    }
  }
  poll();
}

startPollingRouteChanges();

if (isInChat()) {
  waitForScrollContainer(() => void init());
}
