// Saved discoveries in the account (docs/31 step 3). Only signed-in accounts save here; the local
// and Basic owner modes keep the browser's list, since that owner has no account row.
export const MAX_SAVED = 1000;
const MAX_IMPORT = 500;

export class SavedError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Whether `principal` is a signed-in account that can keep saved items. */
export const hasAccount = (principal) => !!principal?.userId && !principal.legacy;

const validId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 300;

/**
 * The account's saved item IDs, newest first.
 * @param {import('pg').Pool} pool
 * @param {string} userId
 */
export async function savedIds(pool, userId) {
  const { rows } = await pool.query(
    'SELECT item_id FROM saved_items WHERE user_id=$1 ORDER BY saved_at DESC, item_id LIMIT $2',
    [userId, MAX_SAVED],
  );
  return rows.map((row) => row.item_id);
}

/**
 * Saves `itemId` for the account if the principal can see it now.
 * @param {import('pg').Pool} pool
 * @param {{ detail: Function }} repository
 * @param {{ userId?: string, role: string }} principal
 * @param {string} itemId
 */
export async function saveItem(pool, repository, principal, itemId) {
  if (!validId(itemId)) throw new SavedError('Invalid item');
  if (!(await repository.detail(itemId, { principal }))) throw new SavedError('Not found', 404);
  const result = await pool.query(
    `INSERT INTO saved_items(user_id, item_id)
     SELECT $1, $2 WHERE (SELECT count(*) FROM saved_items WHERE user_id = $1) < $3
     ON CONFLICT DO NOTHING RETURNING 1`,
    [principal.userId, itemId, MAX_SAVED],
  );
  if (!result.rowCount && !(await isSaved(pool, principal.userId, itemId)))
    throw new SavedError(`You can save up to ${MAX_SAVED} discoveries.`, 409);
}

async function isSaved(pool, userId, itemId) {
  return (
    (
      await pool.query('SELECT 1 FROM saved_items WHERE user_id=$1 AND item_id=$2', [
        userId,
        itemId,
      ])
    ).rowCount > 0
  );
}

/**
 * Removes a saved item (also one that is no longer listed).
 * @param {import('pg').Pool} pool
 * @param {string} userId
 * @param {string} itemId
 */
export async function unsaveItem(pool, userId, itemId) {
  if (!validId(itemId)) throw new SavedError('Invalid item');
  await pool.query('DELETE FROM saved_items WHERE user_id=$1 AND item_id=$2', [userId, itemId]);
}

/**
 * Adds a browser's saved list to the account, keeping only items the principal can see now.
 * Returns how many were added and how many were skipped (already saved, unknown or hidden).
 * @param {import('pg').Pool} pool
 * @param {{ detail: Function }} repository
 * @param {{ userId?: string, role: string }} principal
 * @param {unknown} ids
 */
export async function importItems(pool, repository, principal, ids) {
  if (!Array.isArray(ids) || ids.length > MAX_IMPORT || !ids.every(validId))
    throw new SavedError(`Send at most ${MAX_IMPORT} item IDs`);
  let added = 0;
  const unique = [...new Set(ids)];
  for (const id of unique) {
    if (await isSaved(pool, principal.userId, id)) continue;
    try {
      await saveItem(pool, repository, principal, id);
      added++;
    } catch (error) {
      if (error instanceof SavedError && error.status === 409) break;
    }
  }
  return { added, skipped: unique.length - added };
}
