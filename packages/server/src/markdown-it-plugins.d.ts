declare module 'markdown-it-deflist' {
  const plugin: (md: unknown) => void;
  export default plugin;
}

declare module 'markdown-it-footnote' {
  const plugin: (md: unknown) => void;
  export default plugin;
}

declare module 'markdown-it-mark' {
  const plugin: (md: unknown) => void;
  export default plugin;
}

declare module 'markdown-it-sub' {
  const plugin: (md: unknown) => void;
  export default plugin;
}

declare module 'markdown-it-sup' {
  const plugin: (md: unknown) => void;
  export default plugin;
}

declare module 'markdown-it-task-lists' {
  const plugin: (md: unknown, options?: { enabled?: boolean; label?: boolean; labelAfter?: boolean }) => void;
  export default plugin;
}

declare module 'markdown-it-emoji' {
  export const full: (md: unknown) => void;
}
