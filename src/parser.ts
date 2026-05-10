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
    return attachedFilename.toLowerCase().endsWith(".pdf") ? "PDF attached" : "File attached";
  }
  if (imageAttached) return makePrefixedImageTitle(cleanedText, attachedFilename);
  if (cleanedText) return cleanedText;
  return "Untitled";
}

export function getScrollContainer(): HTMLElement | null {
  return document.querySelector<HTMLElement>(SELECTORS.scrollContainer);
}

export function parseConversation(): Section[] {
  const sc = getScrollContainer();

  console.log("[SmartTabs] parseConversation called", {
    hasScrollContainer: !!sc,
    url: window.location.href,
  });

  if (!sc) return [];

  const containers = Array.from(
    sc.querySelectorAll<HTMLElement>(SELECTORS.conversationContainer)
  );

  console.log("[SmartTabs] conversation-container count:", containers.length);

  const sections: Section[] = [];

  containers.forEach((container, index) => {
    const userQueryEl = container.querySelector<HTMLElement>(SELECTORS.userMessage);
    if (!userQueryEl) return;

    const contentEl = userQueryEl.querySelector<HTMLElement>(SELECTORS.userMessageText);
    // innerText respects newlines so the "You said\n\n" prefix can be stripped reliably.
    const rawText = normalizeText(contentEl?.innerText ?? userQueryEl.innerText ?? "");

    // The parent div with a hex id attribute is the stable turn identifier.
    const turnId =
      userQueryEl.closest<HTMLElement>("div[id]")?.id ?? `gemini-turn-${index}`;

    const imgInContainer = container.querySelector("img") !== null;
    const attachedFilename: string | null = null; // TODO: verify once Gemini attachment DOM is inspected
    const imageAttached = imgInContainer;

    let contextText: string | undefined;
    const modelResponseEl = container.querySelector<HTMLElement>(SELECTORS.assistantMessage);
    if (modelResponseEl) {
      contextText = (modelResponseEl.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1500);
    }

    const generatedId = `smart-${index}-${simpleHash(rawText || turnId)}`;

    console.log(`[SmartTabs] turn[${index}]`, {
      turnId,
      rawText: rawText.slice(0, 60) || "(empty)",
      imageAttached,
      hasContext: !!contextText,
    });

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

  return sections;
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
