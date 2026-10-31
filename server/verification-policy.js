// Vercel Preview runs with NODE_ENV=production. Keep production SaaS email
// verification mandatory, but permit an explicit opt-in for a protected preview.
export function needsEmailVerification({
  saasMode, environment, vercel, vercelEnv, unverifiedPreviewOptIn,
  forceVerification = false,
}) {
  if (!saasMode) return false;
  if (forceVerification) return true;
  const optedInToPreview = vercel === '1' &&
    vercelEnv === 'preview' && unverifiedPreviewOptIn === 'true';
  return environment === 'production' && !optedInToPreview;
}
