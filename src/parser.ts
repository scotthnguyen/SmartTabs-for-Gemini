export interface Section {
  id: string;
  title: string;
  element: HTMLElement;
  rawText: string;
  contextText?: string;
  selectedText?: string;
  role?: "user" | "assistant";
  scrollTop?: number;
  offsetWithinMessage?: number;
  domOrder: number;
  turnId: string;
  type?: "auto" | "bookmark";
}

// Confirmed via live inspection of gemini.google.com.
// Each div.conversation-container wraps one user-query + one model-response.
export const SELECTORS = {
  scrollContainer: "chat-window",
  conversationContainer: "div.conversation-container",
  userMessage: "user-query",
  userMessageText: "user-query-content",
  assistantMessage: "model-response",
} as const;

// Gemini prefixes user text with "You said\n\n" in the DOM.
function normalizeText(text: string): string {
  return text.replace(/^You said\s*\n\s*\n/, "").replace(/\s+/g, " ").trim();
}

function simpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function isImageFilename(filename: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(filename);
}

function makePrefixedImageTitle(cleanedText: string, imageFilename: string | null): string {
  if (!cleanedText) return imageFilename ? `📎 ${imageFilename}` : "📎 Image";
  const words = cleanedText.split(/\s+/);
  if (words.length <= 3 || cleanedText.length <= 20) return `📎 ${cleanedText}`;
  return `📎 ${words.slice(0, 3).join(" ")}...`;
}

function makeTitle(
  userText: string,
  imageAttached: boolean,
  attachedFilename: string | null
): string {
  const cleanedText = normalizeText(userText);
  if (attachedFilename && !isImageFilename(attachedFilename)) {
    return cleanedText ? cleanedText : `📎 ${attachedFilename}`;
  }
  if (imageAttached) return makePrefixedImageTitle(cleanedText, attachedFilename);
  if (cleanedText) return cleanedText;
  return "Untitled";
}

export function getScrollContainer(): HTMLElement | null {
  return document.querySelector<HTMLElement>(SELECTORS.scrollContainer);
}

export type AttachmentCache = Record<string, { imageAttached: boolean; filename: string | null }>;

export function parseConversation(
  attachmentCache: AttachmentCache = {}
): { sections: Section[]; updatedCache: AttachmentCache } {
  if (!getScrollContainer()) return { sections: [], updatedCache: attachmentCache };

  // Ordering is managed by content.ts's turnOrder; querySelectorAll gives whatever
  // elements Gemini's virtual scroll currently has in the DOM.
  const userQueryEls = [...document.querySelectorAll<HTMLElement>(SELECTORS.userMessage)];

  const updatedCache: AttachmentCache = { ...attachmentCache };
  const sections: Section[] = [];

  userQueryEls.forEach((userQueryEl, index) => {
    const container = userQueryEl.closest<HTMLElement>(SELECTORS.conversationContainer);

    const contentEl = userQueryEl.querySelector<HTMLElement>(SELECTORS.userMessageText);
    // innerText respects newlines so the "You said\n\n" prefix can be stripped reliably.
    const rawText = normalizeText(contentEl?.innerText ?? userQueryEl.innerText ?? "");

    // The parent div with a hex id attribute is the stable turn identifier.
    const turnId =
      userQueryEl.closest<HTMLElement>("div[id]")?.id ?? `gemini-turn-${index}`;

    // DOM is authoritative when visible; fall back to persisted cache on reload
    // when blob/data URLs have been revoked and attachment elements are gone.
    const imgs = Array.from(userQueryEl.querySelectorAll<HTMLImageElement>("img"));
    const domImageAttached =
      imgs.some((img) => /^(blob:|data:)/.test(img.src)) ||
      userQueryEl.querySelector('[class*="attachment"],[class*="upload"]') !== null;

    // Probe for a file/PDF chip that Gemini renders inside the user turn.
    const fileAttachmentEl = userQueryEl.querySelector<HTMLElement>(
      '[data-testid*="file"], [class*="file-attachment"], ' +
      '[class*="pdf"], [aria-label*="PDF"], [aria-label*="file"]'
    );
    const fileFilename =
      fileAttachmentEl?.getAttribute("aria-label")?.trim() ||
      fileAttachmentEl?.textContent?.trim().slice(0, 40) ||
      null;

    let imageAttached: boolean;
    let attachedFilename: string | null = fileFilename;

    const stored = attachmentCache[turnId];
    if (domImageAttached) {
      imageAttached = true;
      updatedCache[turnId] = { imageAttached: true, filename: null };
    } else if (stored?.imageAttached) {
      imageAttached = true;
      attachedFilename = attachedFilename ?? stored.filename;
    } else {
      imageAttached = false;
    }

    let contextText: string | undefined;
    if (container) {
      const modelResponseEl = container.querySelector<HTMLElement>(SELECTORS.assistantMessage);
      if (modelResponseEl) {
        contextText = (modelResponseEl.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 1500);
      }
    }

    const generatedId = `smart-${index}-${simpleHash(rawText || turnId)}`;

    sections.push({
      id: generatedId,
      title: makeTitle(rawText, imageAttached, attachedFilename),
      element: userQueryEl,
      rawText,
      contextText,
      role: "user",
      domOrder: index,
      turnId,
      type: "auto",
    });
  });

  return { sections, updatedCache };
}

// Observes chat-window subtree for new conversation-container nodes.
export function observeConversation(onChange: () => void): MutationObserver {
  const target = getScrollContainer() ?? document.body;
  let debounce: number | null = null;

  const observer = new MutationObserver(() => {
    if (debounce !== null) window.clearTimeout(debounce);
    debounce = window.setTimeout(onChange, 200);
  });

  observer.observe(target, { childList: true, subtree: true });
  return observer;
}
