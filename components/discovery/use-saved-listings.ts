'use client';
import { useEffect, useState } from 'react';

type Principal = { userId?: string; role: string; legacy?: boolean };

const readList = (key: string): string[] => {
  try {
    const stored = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(stored) ? stored.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
};

/**
 * Saved discoveries (docs/31). A signed-in account keeps them on the server, so they appear on
 * every device; after sign-in it is offered, once, the items this browser saved before (under
 * the account's old browser key or the owner's shared key). The local and Basic owner modes keep
 * the shared browser key, as their owner has no account. Visitors cannot save.
 * `role` is the signed-in role, or null for a visitor; `known` is false until it is checked.
 */
export function useSavedListings(onError: (message: string) => void) {
  const [saved, setSaved] = useState<string[]>([]);
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [known, setKnown] = useState(false);
  const [browserItems, setBrowserItems] = useState<string[]>([]);

  const account = !!principal?.userId && !principal.legacy;
  const oldKey = principal?.userId ? 'winnigo-saved-' + principal.userId : '';
  const doneKey = principal?.userId ? 'winnigo-saved-imported-' + principal.userId : '';

  useEffect(() => {
    let active = true;
    (async () => {
      const me = await fetch('/api/me')
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);
      if (!active) return;
      setPrincipal(me);
      setKnown(true);
      if (!me) return;
      if (me.legacy) return setSaved(readList('winnigo-saved'));
      const response = await fetch('/api/me/saved').catch(() => null);
      const ids: string[] = response?.ok ? (await response.json()).ids : [];
      if (!active) return;
      setSaved(ids);
      let offered = false;
      try {
        offered = !!localStorage.getItem('winnigo-saved-imported-' + me.userId);
      } catch {}
      if (!offered) {
        const local = [
          ...new Set([...readList('winnigo-saved-' + me.userId), ...readList('winnigo-saved')]),
        ].filter((id) => !ids.includes(id));
        setBrowserItems(local);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function toggleSaved(id: string) {
    if (!principal) return;
    const adding = !saved.includes(id);
    const next = adding ? [id, ...saved] : saved.filter((savedId) => savedId !== id);
    setSaved(next);
    if (!account) {
      try {
        localStorage.setItem('winnigo-saved', JSON.stringify(next));
      } catch {
        onError('Your browser could not save this list.');
      }
      return;
    }
    const response = await fetch('/api/me/saved/' + encodeURIComponent(id), {
      method: adding ? 'PUT' : 'DELETE',
    }).catch(() => null);
    if (!response?.ok) {
      setSaved((current) =>
        adding ? current.filter((savedId) => savedId !== id) : [id, ...current],
      );
      const result = await response?.json().catch(() => null);
      onError(result?.error || 'That change could not be saved. Please try again.');
    }
  }

  /** Marks the browser's old list as offered, so the prompt does not return. */
  function dismissImport() {
    setBrowserItems([]);
    try {
      localStorage.setItem(doneKey, '1');
    } catch {}
  }

  /** Adds the browser's old list to the account, then forgets the account's old browser key. */
  async function importBrowserItems() {
    const response = await fetch('/api/me/saved', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'import', ids: browserItems.slice(0, 500) }),
    }).catch(() => null);
    const result = await response?.json().catch(() => null);
    if (!response?.ok) return onError(result?.error || 'The import could not be completed.');
    setSaved(result.ids);
    dismissImport();
    try {
      localStorage.removeItem(oldKey);
    } catch {}
    return result as { added: number; skipped: number };
  }

  return {
    saved,
    canSave: !!principal,
    // Saved in the account (every device) rather than this browser.
    synced: account,
    canImport: principal?.role === 'owner',
    role: principal?.role ?? null,
    known,
    browserItems: browserItems.length,
    importBrowserItems,
    dismissImport,
    toggleSaved,
  };
}
