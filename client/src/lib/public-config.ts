/** Browser-visible settings only. Never put credentials in VITE_ variables. */
export const PLATFORM_INTEGRATIONS_ENABLED = import.meta.env.VITE_ENABLE_PLATFORM_INTEGRATIONS === 'true';

function safePublicUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

export const DOCUMENTATION_URL = safePublicUrl(import.meta.env.VITE_DOCUMENTATION_URL);
export const PLATFORM_PROFILE_SDK_URL = PLATFORM_INTEGRATIONS_ENABLED
  ? safePublicUrl(import.meta.env.VITE_PLATFORM_PROFILE_SDK_URL)
  : '';
