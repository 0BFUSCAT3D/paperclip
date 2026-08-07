/**
 * Per-task composer draft persistence, shared by the chat composers.
 *
 * Mirrors the behavior of the duplicated copies in IssueChatThread /
 * CommentThread (see IssueChatThread.tsx ~line 3552): draft text is kept in
 * localStorage under the caller-provided key, all access is try/catch-wrapped
 * so a disabled/full store never throws into React, and saving an empty (or
 * whitespace-only) body removes the key rather than storing "". Only the body
 * text persists — no attachments, mode chip, or assignee.
 */

/** Debounce before a keystroke lands in localStorage (matches the legacy copies). */
export const DRAFT_DEBOUNCE_MS = 800;

export function loadDraft(draftKey: string): string {
  try {
    return localStorage.getItem(draftKey) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(draftKey: string, value: string) {
  try {
    if (value.trim()) {
      localStorage.setItem(draftKey, value);
    } else {
      localStorage.removeItem(draftKey);
    }
  } catch {
    // Ignore localStorage failures.
  }
}

export function clearDraft(draftKey: string) {
  try {
    localStorage.removeItem(draftKey);
  } catch {
    // Ignore localStorage failures.
  }
}
