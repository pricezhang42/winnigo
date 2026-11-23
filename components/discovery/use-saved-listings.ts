'use client';
import { useEffect, useState } from 'react';

/**
 * Bookmarked listing IDs, stored in this browser's localStorage under the signed-in account.
 * The legacy owner modes (local/Basic) keep the original shared `winnigo-saved` key.
 * Saving is unavailable until the account is known, and for visitors without an account (public
 * browsing, docs/31). `role` is the signed-in role, or null for a visitor.
 */
export function useSavedListings(onStorageError: () => void) {
  const [saved, setSaved] = useState<string[]>([]);
  const [storageKey, setStorageKey] = useState<string | null>(null);
  const [canImport, setCanImport] = useState(false);
  const [role, setRole] = useState<string | null>(null);
  const [known, setKnown] = useState(false);

  useEffect(() => {
    let active = true;
    fetch('/api/me')
      .then((response) => (response.ok ? response.json() : null))
      .then((principal) => {
        if (!active) return;
        setKnown(true);
        if (!principal) return;
        setRole(principal.role);
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

  return { saved, canSave: storageKey !== null, canImport, role, known, toggleSaved };
}
