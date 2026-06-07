// Ambient declarations so TypeScript accepts `import RASTER_VS from
// './shaders/raster.vert'` etc. At build time, tsup's esbuild text loader
// (see tsup.config.ts) resolves these imports to the raw file contents as
// string literals. The compiler doesn't run the loader, so without these
// declarations it would error on the unknown module shape.

declare module '*.frag' {
  const content: string;
  export default content;
}

declare module '*.vert' {
  const content: string;
  export default content;
}
