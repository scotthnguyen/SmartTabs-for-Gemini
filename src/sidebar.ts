import type { Section } from "./parser";

const SIDEBAR_ID = "smart-tabs-sidebar";
const COLLAPSED_ID = "smart-tabs-collapsed";

let currentSections: Section[] = [];
let activeScrollContainer: HTMLElement | null = null;
let scrollTimeout: number | null = null;
let highlightTimeout: number | null = null;
let lastActiveId: string | null = null;
let isHidden = false;
let latestActions: SidebarActions | null = null;
let keybindInstalled = false;

let navObserver: ResizeObserver | null = null;
let navClickHandler: (() => void) | null = null;
let trackedNavEl: HTMLElement | null = null;

function trackNavPosition(el: HTMLElement) {
  const sidebarEl = document.getElementById(SIDEBAR_ID);
  const collapsedEl = document.getElementById(COLLAPSED_ID);
  if (!sidebarEl && !collapsedEl) return;

  if (trackedNavEl === el) return;

  disconnectNavTracking();

  const chatWindow = document.querySelector("chat-window");
  if (!chatWindow) return;

  const update = () => {
    const currentSidebar = document.getElementById(SIDEBAR_ID);
    const currentCollapsed = document.getElementById(COLLAPSED_ID);
    if (!currentSidebar && !currentCollapsed) return;
    const rect = chatWindow.getBoundingClientRect();
    el.style.left = `${rect.left + 12}px`;
    el.style.top = "60px";
  };

  update();

  // Observe bard-sidenav so updates fire during the CSS transition (no delay).
  // Fall back to document.body if the sidenav element isn't present yet.
  const sidenav = document.querySelector("bard-sidenav") ?? document.body;
  navObserver = new ResizeObserver(update);
  navObserver.observe(sidenav);

  // On click: snap immediately, then correct once after the transition settles.
  navClickHandler = () => { update(); setTimeout(update, 300); };
  document.addEventListener("click", navClickHandler);

  trackedNavEl = el;
}

export function disconnectNavTracking() {
  navObserver?.disconnect();
  navObserver = null;

  if (navClickHandler) {
    document.removeEventListener("click", navClickHandler);
    navClickHandler = null;
  }

  trackedNavEl = null;
}

interface SidebarActions {
  autoTabsEnabled: boolean;
  onRemoveTab: (section: Section) => void;
  onRenameTab: (section: Section, newTitle: string) => void;
  onToggleHidden: () => void;
  onToggleAutoTabs: () => void;
  onCreateBookmark: (section: Section, name: string) => void;
}

export function resetSidebarState() {
  disconnectNavTracking();
  currentSections = [];

  if (activeScrollContainer) {
    activeScrollContainer.removeEventListener("scroll", handleScroll, { passive: true } as EventListenerOptions);
  }

  if (scrollTimeout !== null) {
    window.clearTimeout(scrollTimeout);
    scrollTimeout = null;
  }

  if (highlightTimeout !== null) {
    window.clearTimeout(highlightTimeout);
    highlightTimeout = null;
  }

  document.querySelectorAll(".smart-tab-highlight").forEach((el) => {
    el.classList.remove("smart-tab-highlight");
  });

  document.querySelectorAll(".smart-bookmark-highlight").forEach((el) => {
    el.replaceWith(document.createTextNode(el.textContent || ""));
  });

  activeScrollContainer = null;
  lastActiveId = null;
}

function getScrollableAncestor(el: HTMLElement): HTMLElement | null {
  let parent = el.parentElement;

  while (parent) {
    const style = window.getComputedStyle(parent);

    const canScroll =
      (style.overflowY === "auto" || style.overflowY === "scroll") &&
      parent.scrollHeight > parent.clientHeight;

    if (canScroll) return parent;

    parent = parent.parentElement;
  }

  return null;
}
function showHelpModal() {
  document.getElementById("smart-tabs-help-modal")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "smart-tabs-help-modal";

  const card = document.createElement("div");
  card.className = "smart-tabs-help-card";

  card.innerHTML = `
    <div class="smart-tabs-help-card-header">
      <div>Smart Tabs Help</div>
      <button class="smart-tabs-help-close">×</button>
    </div>

    <div class="smart-tabs-help-section">
      <strong>Bookmarks</strong>
      <p>Highlight text, then press <b>+</b> or <b>⌘/Ctrl+B</b> to bookmark that exact spot.</p>
      <p>If no text is highlighted, <b>+</b> or <b>⌘/Ctrl+B</b> bookmarks your current viewing spot.</p>
      <p>Give the bookmark a name, then click it later to jump back.</p>
    </div>

    <div class="smart-tabs-help-section">
      <strong>Tabs</strong>
      <p><b>Tabs On/Off</b> only shows or hides auto-created tabs. Bookmarks stay visible.</p>
    </div>

    <div class="smart-tabs-help-section">
      <strong>Tips</strong>
      <p>Hover over a tab to see the full title.</p>
      <p>Use <b>✎</b> to rename a tab.</p>
      <p>Use <b>×</b> to remove a tab or bookmark.</p>
    </div>
  `;

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  const close = card.querySelector<HTMLButtonElement>(".smart-tabs-help-close");
  close?.addEventListener("click", () => overlay.remove());

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

function getMessageContainer(node: HTMLElement): HTMLElement {
  return (
    node.closest<HTMLElement>("[data-turn-id-container]") ||
    node.closest<HTMLElement>('[data-testid*="conversation-turn"]') ||
    node.closest<HTMLElement>("article") ||
    node.parentElement ||
    node
  );
}

function getMessageRole(node: HTMLElement): "user" | "assistant" | undefined {
  const roleNode = node.closest<HTMLElement>(
    '[data-message-author-role="user"], [data-message-author-role="assistant"]'
  );

  const role = roleNode?.getAttribute("data-message-author-role");

  if (role === "user" || role === "assistant") return role;
  return undefined;
}

function getElementTopInScrollContainer(
  element: HTMLElement,
  scrollContainer: HTMLElement
): number {
  const elementRect = element.getBoundingClientRect();
  const containerRect = scrollContainer.getBoundingClientRect();

  return elementRect.top - containerRect.top + scrollContainer.scrollTop;
}

function findLiveElement(section: Section): HTMLElement | null {
  if (
    section.element &&
    section.element.isConnected &&
    section.element !== document.body
  ) {
    return section.element;
  }

  if (section.turnId && !section.turnId.startsWith("smart-")) {
    const byTurnId = document.querySelector(
      `[data-turn-id-container="${section.turnId}"]`
    ) as HTMLElement | null;

    if (byTurnId) return byTurnId;
  }

  const messageNodes = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-message-author-role="user"], [data-message-author-role="assistant"]'
    )
  );

  const raw = (section.rawText || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  const selected = (section.selectedText || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  const context = (section.contextText || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  if (!raw && !selected && !context) return null;

  const selectedChunks = [
    selected.slice(0, 100),
    selected.slice(0, 50),
    selected.slice(10, 80),
    selected.slice(-80)
  ].filter((chunk) => chunk.length >= 10);

  const rawChunks = [
    raw.slice(0, 100),
    raw.slice(0, 50),
    raw.slice(10, 80),
    raw.slice(-80)
  ].filter((chunk) => chunk.length >= 10);

  const contextChunks = [
    context.slice(0, 160),
    context.slice(160, 340),
    context.slice(340, 520),
    context.slice(-220)
  ].filter((chunk) => chunk.length >= 20);

  let best: HTMLElement | null = null;
  let bestScore = -1;

  messageNodes.forEach((node) => {
    const container = getMessageContainer(node);
    const text = (container.textContent || "")
      .toLowerCase()
      .replace(/\s+/g, " ");

    let score = 0;

    if (section.role && getMessageRole(node) === section.role) {
      score += 80;
    }

    selectedChunks.forEach((chunk) => {
      if (text.includes(chunk)) score += 220;
    });

    rawChunks.forEach((chunk) => {
      if (text.includes(chunk)) score += 120;
    });

    contextChunks.forEach((chunk) => {
      if (text.includes(chunk)) score += 60;
    });

    if (selected && text.includes(selected)) {
      score += 400;
    }

    if (raw && text.includes(raw)) {
      score += 180;
    }

    if (score > bestScore) {
      bestScore = score;
      best = container;
    }
  });

  if (!best || bestScore <= 0) return null;

  return best;
}

function getVisualTarget(el: HTMLElement): HTMLElement {
  return getMessageContainer(el);
}

function jumpToTarget(target: HTMLElement) {
  const scrollContainer = getScrollableAncestor(target);

  if (!scrollContainer) {
    target.scrollIntoView({ behavior: "auto", block: "start" });
    return;
  }

  const targetTop = getElementTopInScrollContainer(target, scrollContainer);
  scrollContainer.scrollTop = targetTop - 16;
}

function jumpToBookmark(section: Section, target: HTMLElement) {
  const scrollContainer =
    getScrollableAncestor(target) || activeScrollContainer;

  if (!scrollContainer) {
    target.scrollIntoView({ behavior: "auto", block: "start" });
    return;
  }

  const targetTop = getElementTopInScrollContainer(target, scrollContainer);

  if (typeof section.offsetWithinMessage === "number") {
    scrollContainer.scrollTop = targetTop + section.offsetWithinMessage;
    return;
  }

  if (typeof section.scrollTop === "number") {
    scrollContainer.scrollTop = section.scrollTop;
    return;
  }

  scrollContainer.scrollTop = targetTop - 16;
}

function flashTarget(target: HTMLElement, duration = 1400) {
  if (highlightTimeout !== null) {
    window.clearTimeout(highlightTimeout);
    highlightTimeout = null;
  }

  document.querySelectorAll(".smart-tab-highlight").forEach((el) => {
    el.classList.remove("smart-tab-highlight");
  });

  target.classList.add("smart-tab-highlight");

  highlightTimeout = window.setTimeout(() => {
    target.classList.remove("smart-tab-highlight");
    highlightTimeout = null;
  }, duration);
}

function clearTextHighlights() {
  document.querySelectorAll(".smart-bookmark-highlight").forEach((el) => {
    el.replaceWith(document.createTextNode(el.textContent || ""));
  });
}

function highlightTextInside(container: HTMLElement, text: string): boolean {
  if (!text.trim()) return false;

  clearTextHighlights();

  const normalizedTarget = text.toLowerCase().replace(/\s+/g, " ").trim();

  const chunks = [
    normalizedTarget,
    normalizedTarget.slice(0, 80),
    normalizedTarget.slice(0, 40),
    normalizedTarget.slice(10, 70),
    normalizedTarget.slice(-60)
  ].filter((chunk) => chunk.length >= 10);

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node: Text | null;

  while ((node = walker.nextNode() as Text | null)) {
    const content = node.nodeValue || "";
    const normalizedContent = content.toLowerCase().replace(/\s+/g, " ");

    const foundChunk = chunks.find((chunk) =>
      normalizedContent.includes(chunk)
    );

    if (!foundChunk) continue;

    const index = normalizedContent.indexOf(foundChunk);
    if (index === -1) continue;

    const matchLength = Math.min(foundChunk.length, content.length - index);
    const before = content.slice(0, index);
    const match = content.slice(index, index + matchLength);
    const after = content.slice(index + matchLength);

    const span = document.createElement("span");
    span.className = "smart-bookmark-highlight";
    span.textContent = match;

    const parent = node.parentNode;
    if (!parent) return false;

    const frag = document.createDocumentFragment();

    if (before) frag.appendChild(document.createTextNode(before));
    frag.appendChild(span);
    if (after) frag.appendChild(document.createTextNode(after));

    parent.replaceChild(frag, node);

    window.setTimeout(() => {
      if (span.isConnected) {
        span.replaceWith(document.createTextNode(match));
      }
    }, 3000);

    return true;
  }

  return false;
}

function setActiveTab(section: Section) {
  lastActiveId = section.id;

  document.querySelectorAll<HTMLButtonElement>(".smart-tab-item").forEach((el) => {
    if (el.dataset.sectionId === section.id) {
      el.classList.add("smart-tab-active");
    } else {
      el.classList.remove("smart-tab-active");
    }
  });
}

function getTopVisibleSection(scrollContainer: HTMLElement): Section | null {
  const containerRect = scrollContainer.getBoundingClientRect();

  let best: Section | null = null;
  let bestDist = Infinity;

  currentSections.forEach((section) => {
    if (section.type === "bookmark") return;

    const el = findLiveElement(section);
    if (!el) return;

    const target = getVisualTarget(el);
    const rect = target.getBoundingClientRect();

    const visible =
      rect.bottom >= containerRect.top &&
      rect.top <= containerRect.bottom;

    if (!visible) return;

    const dist = Math.abs(rect.top - containerRect.top);

    if (dist < bestDist) {
      bestDist = dist;
      best = section;
    }
  });

  return best;
}

function getCenterVisibleElement(): HTMLElement | null {
  // Gemini web component selectors
  const messageNodes = Array.from(
    document.querySelectorAll<HTMLElement>(
      "user-query, model-response"
    )
  );

  if (!messageNodes.length) return null;

  const centerY = window.innerHeight / 2;

  let best: HTMLElement | null = null;
  let bestDist = Infinity;

  messageNodes.forEach((node) => {
    const rect = node.getBoundingClientRect();

    const visible = rect.bottom >= 0 && rect.top <= window.innerHeight;
    if (!visible) return;

    const messageCenterY = rect.top + rect.height / 2;
    const dist = Math.abs(messageCenterY - centerY);

    if (dist < bestDist) {
      bestDist = dist;
      best = node;
    }
  });

  return best;
}

function getSelectedBookmarkTarget(): {
  element: HTMLElement;
  selectedText: string;
} | null {
  const selection = window.getSelection();
  const selectedText = selection?.toString().trim();

  if (!selection || !selectedText) return null;

  const anchorNode = selection.anchorNode;
  const anchorElement =
    anchorNode instanceof HTMLElement
      ? anchorNode
      : anchorNode?.parentElement;

  if (!anchorElement) return null;

  // Gemini: find the nearest user-query or model-response web component
  const geminiNode = anchorElement.closest<HTMLElement>("user-query, model-response");
  if (geminiNode) return { element: geminiNode, selectedText };

  return null;
}

function buildBookmarkSection(
  element: HTMLElement,
  selectedText?: string
): Section {
  const scrollContainer =
    getScrollableAncestor(element) || activeScrollContainer;

  const messageTop =
    scrollContainer ? getElementTopInScrollContainer(element, scrollContainer) : 0;

  const scrollTop = scrollContainer?.scrollTop ?? 0;
  const offsetWithinMessage = scrollTop - messageTop;

  const contextText = (element.textContent || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1500);

  const realTurnId = element.getAttribute("data-turn-id-container") || "";
  const generatedTurnId = `smart-bookmark-target-${Date.now()}`;

  const role = getMessageRole(element);

  return {
    id: `bookmark-draft-${Date.now()}`,
    title: "Bookmark",
    element,
    rawText: selectedText || contextText,
    selectedText,
    contextText,
    role,
    scrollTop,
    offsetWithinMessage,
    domOrder: Date.now(),
    turnId: realTurnId || generatedTurnId,
    type: "bookmark"
  };
}

function createBookmarkFromCurrentView(actions: SidebarActions) {
  const selectedTarget = getSelectedBookmarkTarget();
  const element = selectedTarget?.element || getCenterVisibleElement();

  if (!element) return;

  const name = window.prompt("Bookmark name?");
  if (!name?.trim()) return;

  const bookmark = buildBookmarkSection(element, selectedTarget?.selectedText);
  actions.onCreateBookmark(bookmark, name.trim());

  window.getSelection()?.removeAllRanges();
}

function installBookmarkKeybind() {
  if (keybindInstalled) return;

  keybindInstalled = true;

  // capture: true fires before any page handler (including Claude.ai's React router),
  // so stopPropagation() by the page cannot suppress this listener.
  // isContentEditable is intentionally excluded: Claude.ai auto-focuses its
  // contentEditable composer on page load, which would permanently block the shortcut.
  window.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement | null;

    const isTyping =
      target?.tagName === "INPUT" ||
      target?.tagName === "TEXTAREA";

    if (isTyping) return;

    const isBookmarkShortcut =
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === "b";

    if (!isBookmarkShortcut) return;

    if (!latestActions) return;

    event.preventDefault();
    createBookmarkFromCurrentView(latestActions);
  }, { capture: true });
}

function updateActiveFromScroll() {
  if (!activeScrollContainer) return;

  const section = getTopVisibleSection(activeScrollContainer);
  if (!section) return;

  setActiveTab(section);
}

function handleScroll() {
  if (scrollTimeout !== null) {
    window.clearTimeout(scrollTimeout);
  }

  scrollTimeout = window.setTimeout(updateActiveFromScroll, 150);
}

function setupScrollTracking() {
  const first = currentSections
    .filter((s) => s.type !== "bookmark")
    .map(findLiveElement)
    .find((el): el is HTMLElement => Boolean(el));

  if (!first) return;

  const container = getScrollableAncestor(first);
  if (!container) return;

  if (activeScrollContainer === container) {
    updateActiveFromScroll();
    return;
  }

  if (activeScrollContainer) {
    activeScrollContainer.removeEventListener("scroll", handleScroll, { passive: true } as EventListenerOptions);
  }

  activeScrollContainer = container;
  activeScrollContainer.addEventListener("scroll", handleScroll, { passive: true });

  updateActiveFromScroll();
}

function showCollapsed(actions: SidebarActions) {
  let btn = document.getElementById(COLLAPSED_ID);

  if (!btn) {
    btn = document.createElement("button");
    btn.id = COLLAPSED_ID;
    btn.textContent = "Tabs";
    document.body.appendChild(btn);
  }

  btn.onclick = () => {
    isHidden = false;
    btn?.remove();
    actions.onToggleHidden();
    renderSidebar(currentSections, actions);
  };

  trackNavPosition(btn);
}

function startRename(
  item: HTMLButtonElement,
  section: Section,
  actions: SidebarActions
) {
  const input = document.createElement("input");
  input.className = "smart-tab-rename-input";
  input.value = section.title;

  item.replaceWith(input);

  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });

  let saved = false;

  const save = () => {
    if (saved) return;
    saved = true;

    const val = input.value.trim();

    if (val && val !== section.title) {
      actions.onRenameTab(section, val);
    } else {
      input.replaceWith(item);
    }
  };

  input.onkeydown = (e) => {
    if (e.key === "Enter") save();

    if (e.key === "Escape") {
      saved = true;
      input.replaceWith(item);
    }
  };

  input.onblur = save;
}

function createTabRow(section: Section, actions: SidebarActions) {
  const row = document.createElement("div");
  row.className = "smart-tab-row";

  const item = document.createElement("button");
  item.className = "smart-tab-item";
  item.textContent = section.title;
  item.title = section.title;
  item.dataset.sectionId = section.id;

  if (section.type === "bookmark") {
    item.classList.add("smart-tab-bookmark");
  }

  item.onclick = () => {
    const live = findLiveElement(section);

    if (section.type === "bookmark") {
      if (live) {
        const target = getVisualTarget(live);

        jumpToBookmark(section, target);
        setActiveTab(section);

        window.setTimeout(() => {
          if (section.selectedText) {
            highlightTextInside(target, section.selectedText);
          }
        }, 150);

        return;
      }

      if (typeof section.scrollTop === "number") {
        const fallback =
          activeScrollContainer ||
          document.querySelector<HTMLElement>("main");

        if (fallback) {
          fallback.scrollTop = section.scrollTop;
          setActiveTab(section);
        }
      }

      return;
    }

    if (!live) return;

    const target = getVisualTarget(live);

    jumpToTarget(target);
    setActiveTab(section);
    flashTarget(target, 1400);
  };

  const rename = document.createElement("button");
  rename.className = "smart-tab-rename";
  rename.textContent = "✎";
  rename.title = "Rename tab";

  rename.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    startRename(item, section, actions);
  });

  const remove = document.createElement("button");
  remove.className = "smart-tab-remove";
  remove.textContent = "×";
  remove.title = "Remove tab";

  remove.onclick = (e) => {
    e.stopPropagation();
    actions.onRemoveTab(section);
  };

  row.appendChild(item);
  row.appendChild(rename);
  row.appendChild(remove);

  return row;
}

export function renderSidebar(sections: Section[], actions: SidebarActions) {
  latestActions = actions;
  installBookmarkKeybind();

  currentSections = sections;

  let sidebar = document.getElementById(SIDEBAR_ID);

  if (isHidden) {
    sidebar?.remove();
    showCollapsed(actions);
    return;
  }

  document.getElementById(COLLAPSED_ID)?.remove();

  if (!sidebar) {
    sidebar = document.createElement("div");
    sidebar.id = SIDEBAR_ID;
    document.body.appendChild(sidebar);
  }

  trackNavPosition(sidebar);

  sidebar.innerHTML = "";

  const header = document.createElement("div");
  header.className = "smart-tabs-header";

  const title = document.createElement("div");
  title.className = "smart-tabs-title";
  title.textContent = "Smart Tabs";

  const help = document.createElement("button");
help.className = "smart-tabs-help-btn";
help.textContent = "?";
help.title = "Smart Tabs help";

help.onclick = () => {
  showHelpModal();
};

  const addBookmark = document.createElement("button");
  addBookmark.className = "smart-tabs-bookmark-btn";
  addBookmark.textContent = "+";
  addBookmark.title = "Bookmark selected text or current spot";

  addBookmark.onclick = () => {
    createBookmarkFromCurrentView(actions);
  };

  const autoToggle = document.createElement("button");
  autoToggle.className = "smart-tabs-auto-toggle-btn";
  autoToggle.textContent = actions.autoTabsEnabled ? "Tabs On" : "Tabs Off";
  autoToggle.title = "Toggle automatic tabs";

  autoToggle.onclick = () => {
    actions.onToggleAutoTabs();
  };

  const hide = document.createElement("button");
  hide.className = "smart-tabs-hide-btn";
  hide.textContent = "Hide";
  hide.title = "Hide Smart Tabs";

  hide.onclick = () => {
    isHidden = true;
    sidebar?.remove();
    actions.onToggleHidden();
    showCollapsed(actions);
  };

  header.appendChild(title);
  header.appendChild(help);
  header.appendChild(addBookmark);
  header.appendChild(hide);
  sidebar.appendChild(header);



  const list = document.createElement("div");
  list.className = "smart-tabs-list";

  const bookmarks = sections.filter((s) => s.type === "bookmark");
  const normal = sections.filter((s) => s.type !== "bookmark");

  
  if (bookmarks.length) {
  const bookmarkHeader = document.createElement("div");
  bookmarkHeader.className = "smart-tabs-divider";
  bookmarkHeader.textContent = "★ Bookmarks";
  list.appendChild(bookmarkHeader);

  bookmarks.forEach((s) => list.appendChild(createTabRow(s, actions)));

  const line = document.createElement("div");
  line.className = "smart-tabs-divider-line";
  list.appendChild(line);
}

autoToggle.className = "smart-tabs-auto-toggle-section-btn";
autoToggle.textContent = actions.autoTabsEnabled ? "Tabs On" : "Tabs Off";
autoToggle.title = "Toggle automatic tabs";

autoToggle.onclick = () => {
  actions.onToggleAutoTabs();
};

list.appendChild(autoToggle);

if (actions.autoTabsEnabled) {
  normal.forEach((s) => list.appendChild(createTabRow(s, actions)));
}
  sidebar.appendChild(list);

  if (sections.length) {
    const active =
      sections.find((s) => s.id === lastActiveId) || normal[0] || sections[0];

    setActiveTab(active);
  }

  setupScrollTracking();
}