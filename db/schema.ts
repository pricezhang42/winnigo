import {sqliteTable,text,integer,index} from 'drizzle-orm/sqlite-core';
export const listings=sqliteTable('listings',{id:text('id').primaryKey(),source:text('source').notNull(),payload:text('payload').notNull(),hidden:integer('hidden').notNull().default(0),override:text('override')},t=>[index('idx_listings_source').on(t.source)]);
export const sources=sqliteTable('sources',{id:text('id').primaryKey(),checkedAt:text('checked_at').notNull(),attemptedAt:text('attempted_at').notNull(),count:integer('count').notNull().default(0),status:text('status').notNull(),error:text('error')});
