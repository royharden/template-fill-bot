// Browser declarations deliberately keep Node ambient types out of the main tsconfig.
declare module '*?raw' { const text: string; export default text; }
declare module '*.css';
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv; }
