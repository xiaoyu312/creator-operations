/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_PLATFORM_INTEGRATIONS?: string;
  readonly VITE_DOCUMENTATION_URL?: string;
  readonly VITE_PLATFORM_PROFILE_SDK_URL?: string;
}

interface ImportMeta { readonly env: ImportMetaEnv }
