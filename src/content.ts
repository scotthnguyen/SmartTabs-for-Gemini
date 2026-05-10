import { parseConversation, observeConversation, getScrollContainer, type Section } from "./parser";
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
const SENTINEL_ID = "smarttabs-root";

// Keyed by chat UUID (not full pathname)
let currentChatId = "";
let autoTabsEnabled = true;
let conversationObserver: MutationObserver | null = null;
let initGeneration = 0;

const sectionMap = new Map<string, Section>();
const removedKeys = new Set<string>();

type StoredBookmark = Omit<Section, "element">;

function getKey(section: Section): string {
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
  resetSidebarState();
  await loadBookmarksForCurrentChat();
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
  renderSidebar(getOrderedSections(), {
    autoTabsEnabled,
    onRemoveTab: removeTab,
    onRenameTab: renameTab,
    onToggleHidden: () => {},
    onToggleAutoTabs: toggleAutoTabs,
    onCreateBookmark: createLocationBookmark,
  });
}

function mergeSections(newSections: Section[]) {
  newSections.forEach((section) => {
    const key = getKey(section);
    const existing = sectionMap.get(key);

    if (existing) {
      sectionMap.set(key, { ...section, title: existing.title });
    } else {
      sectionMap.set(key, section);
    }
  });

  renderCurrentSidebar();
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

  sectionMap.set(key, { ...existing, title: newTitle });

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
  conversationObserver?.disconnect();
  conversationObserver = null;
  // Remove sidebar instantly — don't wait for re-init
  removeSidebarFromPage();

  // Generation counter: if a second navigation fires during the 400ms wait,
  // the stale setTimeout callback checks gen and silently exits.
  const gen = ++initGeneration;
  window.setTimeout(() => {
    if (gen === initGeneration) void init();
  }, 400);
}

async function init(): Promise<void> {
  console.log("[SmartTabs] init called", {
    pathname: window.location.pathname,
    isInChat: isInChat(),
    chatId: getChatId(),
    sentinelPresent: !!document.getElementById(SENTINEL_ID),
    currentChatId,
  });

  // Prevent double-injection: sentinel is removed by removeSidebarFromPage()
  if (document.getElementById(SENTINEL_ID)) {
    console.log("[SmartTabs] init bailed — sentinel already present");
    return;
  }

  const sentinel = document.createElement("div");
  sentinel.id = SENTINEL_ID;
  sentinel.style.display = "none";
  document.body.appendChild(sentinel);

  const newChatId = getChatId();

  // Not on a /chat/<uuid> page — ensure sidebar is gone and bail
  if (!isInChat() || !newChatId) {
    console.log("[SmartTabs] init bailed — not in chat", { isInChat: isInChat(), newChatId });
    removeSidebarFromPage();
    return;
  }

  if (newChatId !== currentChatId) {
    currentChatId = newChatId;
    await resetForNewChat();
  }

  console.log("[SmartTabs] init calling parseConversation");
  const parsed = parseConversation();
  mergeSections(parsed);

  conversationObserver = observeConversation(() => {
    mergeSections(parseConversation());
  });
}

// Gemini is an Angular SPA — the scroll container may not exist at document_idle.
// Only wait for it when we're already on a conversation page; on /app and other
// pages there is no scroll container and we'd hang until timeout.
function waitForScrollContainer(callback: () => void, timeoutMs = 10000) {
  const start = Date.now();
  function poll() {
    const sc = getScrollContainer();
    if (sc) {
      console.log("[SmartTabs] scroll container found", {
        tag: sc.tagName,
        className: sc.className.slice(0, 100),
        scrollHeight: sc.scrollHeight,
        elapsed: Date.now() - start,
      });
      callback();
    } else if (Date.now() - start < timeoutMs) {
      window.setTimeout(poll, 200);
    } else {
      console.warn("[SmartTabs] waitForScrollContainer timed out after", timeoutMs, "ms — scroll container never found");
    }
  }
  poll();
}

console.log("[SmartTabs] bootstrap", {
  pathname: window.location.pathname,
  isInChat: isInChat(),
  chatId: getChatId(),
});

startPollingRouteChanges();

if (isInChat()) {
  waitForScrollContainer(() => void init());
} else {
  console.log("[SmartTabs] not in chat at load — skipping init, polling for route change");
}
