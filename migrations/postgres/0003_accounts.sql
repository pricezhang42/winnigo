create table "auth_user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table "auth_session" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references "auth_user" ("id") on delete cascade);

create table "auth_account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "auth_user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);

create table "auth_verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table "auth_rate_limit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);

create index "auth_session_userId_idx" on "auth_session" ("userId");

create index "auth_account_userId_idx" on "auth_account" ("userId");

create index "auth_verification_identifier_idx" on "auth_verification" ("identifier");

-- Winnigo owns authorization independently of provider profile fields.
CREATE TABLE user_access (user_id text PRIMARY KEY REFERENCES auth_user(id) ON DELETE CASCADE, role text NOT NULL DEFAULT 'user' CHECK(role IN ('owner','admin','user')), enabled boolean NOT NULL DEFAULT true);
CREATE UNIQUE INDEX single_owner ON user_access(role) WHERE role='owner';
CREATE TABLE account_invitations (email text PRIMARY KEY, expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days');
CREATE TABLE source_grants (user_id text REFERENCES auth_user(id) ON DELETE CASCADE, source_id text REFERENCES sources(id) ON DELETE CASCADE, PRIMARY KEY(user_id,source_id));
CREATE TABLE listing_grants (user_id text REFERENCES auth_user(id) ON DELETE CASCADE, listing_id text REFERENCES listings(id) ON DELETE CASCADE, PRIMARY KEY(user_id,listing_id));
CREATE TABLE service_credentials (id text PRIMARY KEY, token_hash text NOT NULL UNIQUE, source_id text NOT NULL REFERENCES sources(id), label text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, revoked_at timestamptz);
CREATE TABLE request_limits (key text PRIMARY KEY, window_start timestamptz NOT NULL, count integer NOT NULL);
CREATE TABLE security_audit (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, action text NOT NULL, user_id text REFERENCES auth_user(id) ON DELETE SET NULL, subject_id text, created_at timestamptz NOT NULL DEFAULT now());
