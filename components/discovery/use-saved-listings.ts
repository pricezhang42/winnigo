'use client';
import { useEffect, useState } from 'react';

/**
 * Bookmarked listing IDs, stored in this browser's localStorage under the signed-in account.
 * The legacy owner modes (local/Basic) keep the original shared `winnigo-saved` key.
 * Saving is unavailable until the account is known. Server-side bookmarks arrive in P4.
 */
export function useSavedListings(onStorageError: () => void) {
  const [saved, setSaved] = useState<string[]>([]);
  const [storageKey, setStorageKey] = useState<string | null>(null);
  const [canImport, setCanImport] = useState(false);

  useEffect(() => {
    let active = true;
    fetch('/api/me')
      .then((response) => (response.ok ? response.json() : null))
      .then((principal) => {
        if (!active || !principal) return;
        setCanImport(principal.role === 'owner');
        const key = principal.legacy ? 'winnigo-saved' : 'winnigo-saved-' + principal.userId;
        setStorageKey(key);
        try {
          const stored = JSON.parse(localStorage.getItem(key) || '[]');
          setSaved(Array.isArray(stored) ? stored.filter((id) => typeof id === 'string') : []);
        } catch {}
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  function toggleSaved(id: string) {
    if (!storageKey) return;
    setSaved((old) => {
      const next = old.includes(id) ? old.filter((savedId) => savedId !== id) : [...old, id];
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        onStorageError();
      }
      return next;
    });
  }

  return { saved, canSave: storageKey !== null, canImport, toggleSaved };
}
