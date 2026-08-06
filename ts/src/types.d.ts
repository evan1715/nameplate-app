/**
 * types.d.ts — declarations for the two dependencies that ship no usable types.
 *
 * `jsts` publishes a UMD bundle with no type declarations and no package entry
 * point; `canvaskit-wasm`'s own types describe the module object rather than the
 * default-exported initialiser. Both are used through thin wrappers (geom.ts and
 * skia.ts), so `any` here is contained rather than spread through the port.
 */

/** The jsts UMD bundle. Imported for its side effect; it installs `globalThis.jsts`. */
declare module "jsts/dist/jsts.min.js";

declare module "canvaskit-wasm" {
  /** Load the CanvasKit WASM module. */
  const CanvasKitInit: (opts?: { locateFile?: (file: string) => string }) => Promise<any>;
  export default CanvasKitInit;
}
