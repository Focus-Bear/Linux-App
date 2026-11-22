// Whether an embedded dashboard page that is already loaded may be shown again
// as it is. No Electron imports (webviewReuse.test.js).

/** What a page was loaded with: whose sign-in, and which access token. */
export function signInOf(metadata) {
  return {
    userId: (metadata && metadata.user && metadata.user.sub) || '',
    token: (metadata && metadata.access_token) || '',
  };
}

/**
 * 'reuse' or 'reload'. A page is loaded again when someone else is signed in
 * now, or when the access token has been replaced since (the page keeps the
 * token it was given and its requests start failing once that one expires).
 * A request without a sign-in (the token could not be read) changes nothing.
 */
export function reuseDecision(loadedWith, metadata) {
  const now = signInOf(metadata);
  if (!loadedWith || !now.token) return 'reuse';
  if (now.userId !== loadedWith.userId) return 'reload';
  return now.token !== loadedWith.token ? 'reload' : 'reuse';
}
