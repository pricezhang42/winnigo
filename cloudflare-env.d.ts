declare namespace Cloudflare {
  interface Env {
    ASSETS?: Fetcher;
    DB?: D1Database;
    BUCKET?: R2Bucket;
    WINNIGO_AUTH_MODE?: string;
    WINNIGO_ADMIN_USER?: string;
    WINNIGO_ADMIN_PASSWORD?: string;
    WINNIGO_COLLECTOR_KEY?: string;
  }
}
