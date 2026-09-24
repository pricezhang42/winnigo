// Target v1 contracts for the migration. Not yet attached to legacy endpoints.
import {z} from 'zod';
const text = z.string().trim().min(1);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {
  const d = new Date(s + 'T12:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}, 'Invalid calendar date');
const url = z.string().url().refine(s => {
  const u = new URL(s);
  return u.protocol === 'https:' && !u.username && !u.password;
}, 'Use an HTTPS source URL without credentials');
export const locationSchema = z.object({
  label: text.max(200),
  kind: z.enum(['trailhead', 'route', 'park', 'lake', 'area']),
  latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
  approximate: z.boolean(), sourceUrl: url,
  uncertainty: text.max(600).nullable(),
}).strict().superRefine((v, ctx) => {
  if (['park','lake','area'].includes(v.kind) && !v.approximate)
    ctx.addIssue({code: 'custom', message: 'Area markers must be approximate'});
  if (v.approximate && !v.uncertainty)
    ctx.addIssue({code: 'custom', message: 'Approximate locations need an explanation'});
});
const occurrence = z.object({start: date, end: date, time: text.max(200).nullable()}).strict()
  .refine(v => v.end >= v.start, 'End must follow start');
const difficulty = z.enum(['Easy','Moderate','Challenging','Level 1 / 4','Level 2 / 4','Level 3 / 4','Level 4 / 4']);
const shape = {
  source: text.max(100), sourceId: text.max(300), sourceUrl: url,
  visibility: z.enum(['public','restricted']),
  collection: z.enum(['All discoveries','Community Highlights','Official Trails']),
  title: text.max(200), description: text.max(2000),
  type: z.enum(['Event','Place','Activity']), category: text.max(100),
  status: z.enum(['active','cancelled','closed']),
  checkedAt: z.string().datetime({offset: true}),
  price: z.number().min(0).nullable(), family: z.boolean().nullable(), indoor: z.boolean().nullable(),
  difficulty: difficulty.nullable(), distanceKm: z.number().positive().max(2000).nullable(),
  occurrences: z.array(occurrence).max(1000),
  restrictions: z.array(text.max(600)).max(50),
  seasons: z.array(z.enum(['Summer','Winter'])).max(2),
  trailVariants: z.array(z.object({
    season:z.enum(['Summer','Winter']), sourceUrl:url, distanceKm:z.number().positive().max(2000).nullable(),
    difficulty:difficulty.nullable(), activities:z.array(text.max(100)).max(20),
    restrictions:z.array(text.max(600)).max(50), considerations:z.array(text.max(600)).max(50),
  }).strict()).max(20),
  location: locationSchema.nullable(),
  mediaIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(20),
  commentNotes: z.array(z.object({text: text.max(600), sourceUrl: url}).strict()).max(10),
};
function rules(v,ctx) {
  if (v.source === 'facebook' && (v.collection !== 'Community Highlights' || v.visibility !== 'restricted'))
    ctx.addIssue({code:'custom',message:'Facebook imports remain restricted Community Highlights'});
  if (v.source === 'trails-manitoba' && v.collection !== 'Official Trails')
    ctx.addIssue({code:'custom',message:'Trails Manitoba imports are Official Trails'});
  if (v.type === 'Event' && !v.occurrences.length)
    ctx.addIssue({code:'custom',message:'Events need confirmed occurrences'});
}
export const listingImportSchema = z.object(shape).strict().superRefine(rules);
// No owner IDs, hidden flags, source payloads or overrides in the discovery DTO.
export const listingResponseSchema = z.object({...shape,id:text.max(300)}).strict().superRefine(rules);
export const discoveryResponseSchema = z.object({
  items:z.array(listingResponseSchema).max(100), nextCursor:text.max(2000).nullable(), total:z.number().int().nonnegative(),
}).strict();
export const preferencesSchema = z.object({
  interests:z.array(text.max(100)).max(30), neighbourhoods:z.array(text.max(100)).max(30),
  travelRadiusKm:z.number().positive().max(2000).nullable(), budget:z.number().nonnegative().nullable(),
  setting:z.enum(['any','indoor','outdoor']), familyFriendly:z.boolean().nullable(),
  difficulties:z.array(z.enum(['Easy','Moderate','Challenging'])).max(3),
  maximumDistanceKm:z.number().positive().max(2000).nullable(),
  accessibilityRequirements:z.array(text.max(200)).max(10),
}).strict();
