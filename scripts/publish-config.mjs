export function publishingConfig(env) {
  const url = new URL(env.WINNIGO_ORIGIN || 'http://127.0.0.1:5173');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw Error('WINNIGO_ORIGIN must be an origin without credentials or path.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    throw Error('Remote imports require HTTPS.');
  if (!env.WINNIGO_COLLECTOR_KEY)
    throw Error('Set WINNIGO_COLLECTOR_KEY to the destination collector secret.');
  const headers = {
    'Content-Type': 'application/json',
    Origin: url.origin,
    'X-Winnigo-Collector-Key': env.WINNIGO_COLLECTOR_KEY,
  };
  if (url.hostname.endsWith('.chatgpt.site')) {
    if (!env.WINNIGO_AUTH_TOKEN)
      throw Error(
        'The existing Sites host requires an optional Sites owner token. Use a standalone deployment to avoid that dependency.',
      );
    headers['OAI-Sites-Authorization'] = 'Bearer ' + env.WINNIGO_AUTH_TOKEN;
  }
  return { origin: url.origin, headers };
}
