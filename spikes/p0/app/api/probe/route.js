import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {betterAuth} from 'better-auth';
import {S3Client} from '@aws-sdk/client-s3';
export const runtime = 'nodejs';
export async function GET() {
  return Response.json({node: process.version, imports: [Pool, drizzle, betterAuth, S3Client].every(x => typeof x === 'function')});
}
