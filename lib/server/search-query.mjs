import { z } from 'zod';
const schema = z
  .object({
    query: z.string().max(200).default(''),
    collection: z
      .enum(['All discoveries', 'Community Highlights', 'Official Trails'])
      .default('All discoveries'),
    category: z.string().max(100).default('All'),
    area: z.string().max(100).default('All neighbourhoods'),
    tab: z
      .enum(['Explore', 'Events', 'Places', 'Activities', 'Trail map', 'Saved'])
      .default('Explore'),
    quick: z
      .enum(['Anytime', 'Today', 'This weekend', 'Free', 'Family-friendly', 'Indoors'])
      .default('Anytime'),
    limit: z.coerce.number().int().min(1).max(100).default(24),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
    season: z.enum(['Any', 'Summer', 'Winter']).default('Any'),
    difficulty: z.string().max(100).default('Any'),
    distance: z.enum(['Any', 'short', 'medium', 'long']).default('Any'),
    ids: z
      .string()
      .max(20000)
      .refine((v) => v.split(',').length <= 200, 'At most 200 saved IDs')
      .optional(),
  })
  .strict();
export function parseSearch(params) {
  const q = schema.parse(Object.fromEntries(params));
  return { ...q, ids: q.ids ? q.ids.split(',') : [] };
}
