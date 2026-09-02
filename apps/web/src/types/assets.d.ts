/**
 * Ambient declarations for non-code imports.
 *
 * Next.js handles CSS imports at build time, but TypeScript needs to be told the
 * modules exist — without this, a side-effect import such as
 * `import './globals.css'` is reported as TS2882.
 */

declare module '*.css';
declare module '*.scss';
declare module '*.sass';
