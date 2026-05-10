# SmartTabs for Gemini

## Project Overview
Chrome extension (Manifest V3, TypeScript) that injects a navigation sidebar
into Gemini (gemini.google.com) conversations. Lets users jump to earlier
prompts or bookmarked locations instead of scrolling.

## Architecture
- `content.ts` — injects sidebar, handles SPA navigation polling
- `parser.ts` — parses Gemini DOM into Section objects
- `sidebar.ts` — renders sidebar UI and handles interactions
- `styles.css` — sidebar styling
- `manifest.json` — MV3 manifest targeting gemini.google.com

## Section Model
```typescript
interface Section {
  id: string
  title: string
  element: HTMLElement   // the user-query element itself
  rawText: string
  domOrder: number
  turnId: string         // hex id from the parent div[id], e.g. "1b654518cb1f3856"
  type: "auto" | "bookmark"
  contextText?: string
  role?: "user" | "assistant"
  selectedText?: string
  scrollTop?: number
  offsetWithinMessage?: number
}
```

## Confirmed Gemini DOM Structure (live-inspected)

Gemini uses Angular web components — no `data-testid` attributes.

```
chat-window                          ← scroll container
  div.conversation-container         ← shared wrapper, has hex id attr
    user-query                       ← user turn
      user-query-content             ← contains "You said\n\nactual text"
    model-response                   ← assistant turn
  div.conversation-container
    user-query
      user-query-content
    model-response
  ...
```

All selectors are in the `SELECTORS` const in `parser.ts` — never hardcode them.

| Selector key           | Value                        | Notes                              |
|------------------------|------------------------------|------------------------------------|
| `scrollContainer`      | `chat-window`                | Angular custom element             |
| `conversationContainer`| `div.conversation-container` | Wraps one user + one model turn    |
| `userMessage`          | `user-query`                 | Angular custom element             |
| `userMessageText`      | `user-query-content`         | Child of user-query; use innerText |
| `assistantMessage`     | `model-response`             | Angular custom element             |

## Key Implementation Details

- **Text extraction**: use `innerText` on `user-query-content` (not `textContent`)
  so the "You said\n\n" prefix can be reliably stripped with a regex.
- **Turn ID**: `userQueryEl.closest('div[id]')?.id ?? 'gemini-turn-${index}'`
  — the parent `div.conversation-container` carries a stable hex id.
- **`section.element`**: set directly to the `user-query` element. 
  `sidebar.ts`'s `getMessageContainer()` falls back to `node.parentElement`, 
  which returns `div.conversation-container` — the correct scroll/highlight target.
- **Context text**: the `model-response` inside the same `conversation-container`.

## URL Pattern
- Conversation: `https://gemini.google.com/app/<hex-id>`
- `getChatId()`: `location.pathname.match(/\/app\/([^/]+)/)?.[1]`
- `isInChat()`: `/\/app\/[^/]+/.test(location.pathname)`

## Key Rules
- Always use `SELECTORS` from `parser.ts` — no hardcoded selector strings
- `parser.ts` exports: `SELECTORS`, `Section`, `parseConversation()`, `observeConversation()`, `getScrollContainer()`
- Debounce MutationObserver callbacks 200ms
- Guard against double-injection with `#smarttabs-root` sentinel
- On SPA route change: disconnect observer → remove sidebar instantly → re-init after 400ms
- Sidebar shown only on `/app/<id>` pages; removed immediately on all other routes
- Bookmarks persisted via `chrome.storage.local`, keyed by chat hex id
- Bookmark shortcut: **Cmd/Ctrl+B**
- Gemini is an Angular SPA — poll for `chat-window` before mounting (up to 10s)
- Storage operations are async — fire-and-forget from event handlers is intentional

## Known Limitations
- ⚠️ File/image attachment selector not yet confirmed — `attachedFilename` is
  hardcoded `null` in parser.ts until Gemini's attachment DOM is inspected
- ⚠️ `getMessageRole()` in sidebar.ts queries `[data-message-author-role]` which
  Gemini does not use — scroll-tracking active-tab still works, role tie-breaker
  is skipped (non-breaking)

## Build
```bash
npm run build   # vite bundle → dist/content.js
npm run watch   # watch mode
```

## Testing Workflow
1. `npm run build`
2. Load `dist/` as unpacked extension in Chrome (`chrome://extensions`)
3. Navigate to `https://gemini.google.com/app/<any-conversation>`
4. Open DevTools → Console; confirm `[SmartTabs] conversation-container count: N`
5. Sidebar should populate with one tab per user message
