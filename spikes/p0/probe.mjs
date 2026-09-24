import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setTimeout as sleep} from 'node:timers/promises';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {pgTable, text, timestamp, boolean, integer, jsonb} from 'drizzle-orm/pg-core';
import {sql, eq} from 'drizzle-orm';
import {betterAuth} from 'better-auth';
import {getMigrations} from 'better-auth/db/migration';
import {drizzleAdapter} from '@better-auth/drizzle-adapter';
import {PgBoss} from 'pg-boss';
import {S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
const f=JSON.parse(readFileSync(new URL('../../scripts/fixtures/p0-discovery.json',import.meta.url)));
const dbURL=new URL(process.env.DATABASE_URL);
assert.equal(dbURL.hostname,'127.0.0.1');assert.equal(dbURL.pathname,'/winnigo_p0');assert.equal(dbURL.port,'55432');
const pool=new Pool({connectionString:dbURL.href});
const db=drizzle(pool);
const boss=new PgBoss({connectionString:dbURL.href,schema:'p0_jobs',supervise:false,schedule:false});
const checks=[];
let auth, s3;
try {
 const version=await pool.query('SHOW server_version');
 checks.push(`PostgreSQL ${version.rows[0].server_version}`);
 await pool.query('CREATE TABLE IF NOT EXISTS p0_listing (id text PRIMARY KEY,payload jsonb NOT NULL,hidden boolean NOT NULL,override jsonb NOT NULL)');
 const listing=pgTable('p0_listing',{id:text().primaryKey(),payload:jsonb(),hidden:boolean(),override:jsonb()});
 await db.insert(listing).values({id:'fixture',payload:f.listing,...f.stored}).onConflictDoNothing();
 await db.insert(listing).values({id:'fixture',payload:{...f.listing,title:'Source updated'},hidden:false,override:{}}).onConflictDoUpdate({target:listing.id,set:{payload:{...f.listing,title:'Source updated'}}});
 const [stored]=await db.select().from(listing).where(eq(listing.id,'fixture'));
 assert.equal(stored.hidden,true);assert.deepEqual(stored.override,f.stored.override);
 await assert.rejects(db.transaction(async tx=>{await tx.delete(listing);throw Error('intentional rollback');}),/intentional rollback/);
 assert.equal((await db.select().from(listing)).length,1);
 checks.push('Drizzle JSONB upsert preserves hidden state and editorial overrides; transaction rollback');
 // Bootstrap only this disposable probe DB with Better Auth's built-in migrator.
 // Production will use reviewed Drizzle migrations (P3), not runtime DDL.
 const migrationPool=new Pool({connectionString:dbURL.href});
 const options={database:migrationPool,secret:process.env.P0_AUTH_SECRET,baseURL:'http://localhost:5188',emailAndPassword:{enabled:true}};
 const migrations=await getMigrations(options);await migrations.runMigrations();await migrationPool.end();
 const common={id:text('id').primaryKey(),createdAt:timestamp('createdAt'),updatedAt:timestamp('updatedAt')};
 const user=pgTable('user',{...common,name:text('name'),email:text('email'),emailVerified:boolean('emailVerified'),image:text('image')});
 const session=pgTable('session',{...common,expiresAt:timestamp('expiresAt'),token:text('token'),ipAddress:text('ipAddress'),userAgent:text('userAgent'),userId:text('userId')});
 const account=pgTable('account',{...common,accountId:text('accountId'),providerId:text('providerId'),userId:text('userId'),accessToken:text('accessToken'),refreshToken:text('refreshToken'),idToken:text('idToken'),accessTokenExpiresAt:timestamp('accessTokenExpiresAt'),refreshTokenExpiresAt:timestamp('refreshTokenExpiresAt'),scope:text('scope'),password:text('password')});
 const verification=pgTable('verification',{...common,identifier:text('identifier'),value:text('value'),expiresAt:timestamp('expiresAt')});
 auth=betterAuth({...options,database:drizzleAdapter(drizzle(pool,{schema:{user,session,account,verification}}),{provider:'pg',schema:{user,session,account,verification}})});
 const email=`p0-${randomUUID()}@example.com`, password=randomUUID();
 const created=await auth.api.signUpEmail({body:{email,password,name:'Synthetic P0 user'}});
 assert.equal(created.user.email,email);
 const login=await auth.api.signInEmail({body:{email,password},asResponse:true});assert.equal(login.status,200);
 const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
 const headers=new Headers({cookie,origin:'http://localhost:5188'});
 assert.equal((await auth.api.getSession({headers})).user.email,email);
 assert.equal(await auth.api.getSession({headers:new Headers()}),null);
 await auth.api.signOut({headers});assert.equal(await auth.api.getSession({headers}),null);
 await db.delete(user).where(eq(user.id,created.user.id));
 checks.push('Better Auth + Drizzle: signup, signin, persisted session, anonymous denial, signout revocation');
 await boss.start();await boss.createQueue('p0');await boss.deleteAllJobs('p0');
 const id=await boss.send('p0',{fixture:true},{retryLimit:2,retryDelay:0,expireInSeconds:1,heartbeatSeconds:10});
 assert.equal((await boss.fetch('p0'))[0].id,id);
 assert.equal((await boss.fetch('p0')).length,0);
 await boss.fail('p0',id,{reason:'synthetic failure'});
 assert.equal((await boss.fetch('p0'))[0].id,id);
 // Simulate abandoned work; supervisor reclaims the expired active lease.
 await sleep(1200);await boss.supervise('p0');
 const recovered=await boss.fetch('p0',{includeMetadata:true});
 assert.equal(recovered[0]?.id,id);assert.equal(recovered[0].retryCount,2);
 await boss.complete('p0',id);
 await boss.schedule('p0','0 9 * * *',{}, {tz:'America/Winnipeg'});
 assert.equal((await boss.getSchedule('p0')).timezone,'America/Winnipeg');
 for(const [from,expected] of [['2026-03-07T00:00:00Z',['2026-03-07T15:00:00.000Z','2026-03-08T14:00:00.000Z']],['2026-10-31T00:00:00Z',['2026-10-31T14:00:00.000Z','2026-11-01T15:00:00.000Z']]])
   assert.deepEqual(boss.previewSchedule('0 9 * * *',{tz:'America/Winnipeg',from:new Date(from),count:2}).map(d=>d.toISOString()),expected);
 await boss.unschedule('p0');
 checks.push('pg-boss: exclusive fetch, retry, expired lease recovery, persisted 09:00 Winnipeg schedule, spring/fall DST');
 s3=new S3Client({region:'us-east-1',endpoint:'http://127.0.0.1:58333',forcePathStyle:true,credentials:{accessKeyId:process.env.P0_S3_KEY,secretAccessKey:process.env.P0_S3_SECRET}});
 const key=`probe/${randomUUID()}`, target={Bucket:'winnigo-p0',Key:key};
 const body=Buffer.from('Synthetic private P0 photo bytes');
 try {
  await s3.send(new PutObjectCommand({...target,Body:body,ContentType:'application/octet-stream',Metadata:{purpose:'p0-fixture'}}));
  const head=await s3.send(new HeadObjectCommand(target));assert.equal(head.ContentLength,body.length);assert.equal(head.Metadata.purpose,'p0-fixture');
  const got=await s3.send(new GetObjectCommand(target));assert.equal(await got.Body.transformToString(),body.toString());
  const anonymous=await fetch(`http://127.0.0.1:58333/winnigo-p0/${key}`);assert.equal(anonymous.status,403);
  const signed=await getSignedUrl(s3,new GetObjectCommand(target),{expiresIn:30});
  assert.equal(await (await fetch(signed)).text(),body.toString());
 } finally {await s3.send(new DeleteObjectCommand(target));}
 await assert.rejects(s3.send(new HeadObjectCommand(target)),e=>e.$metadata.httpStatusCode===404);
 checks.push('SeaweedFS: private put/head/get, metadata, signed GET, anonymous 403, delete/404');
 console.log(JSON.stringify({status:'passed',node:process.version,checks},null,2));
} finally {
 await boss.stop({graceful:false});s3?.destroy();await pool.end();
}
