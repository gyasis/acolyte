declare module 'katex/contrib/auto-render' {
  const renderMathInElement: (
    el: HTMLElement,
    options?: {
      delimiters?: { left: string; right: string; display: boolean }[];
      ignoredTags?: string[];
      throwOnError?: boolean;
    }
  ) => void;
  export default renderMathInElement;
}
