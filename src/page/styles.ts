/**
 * One inline stylesheet. The page loads no external asset, so the Content Security Policy can
 * refuse every remote origin and the page renders the same way with no network beyond this Worker.
 */
export const OWNER_PAGE_STYLES = `
  :root { color-scheme: light dark; }
  body {
    font-family: ui-sans-serif, system-ui, sans-serif;
    margin: 0 auto;
    max-width: 60rem;
    padding: 1.5rem 1rem 4rem;
    line-height: 1.45;
  }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; margin-bottom: 0.4rem; }
  section {
    border: 1px solid rgba(128, 128, 128, 0.4);
    border-radius: 6px;
    margin-bottom: 1rem;
    padding: 0.75rem 1rem 1rem;
  }
  .row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin: 0.35rem 0; }
  .field-label {
    color: rgba(90, 90, 90, 1);
    display: inline-block;
    font-size: 0.8rem;
    min-width: 11rem;
    text-transform: uppercase;
  }
  .value { font-family: ui-monospace, monospace; word-break: break-all; }
  input, textarea, button { font: inherit; }
  input, textarea { padding: 0.3rem 0.4rem; }
  input[type="text"] { min-width: 22rem; }
  input[type="number"] { width: 7rem; }
  textarea { width: 100%; min-height: 5rem; }
  button { cursor: pointer; padding: 0.35rem 0.8rem; }
  pre {
    background: rgba(128, 128, 128, 0.12);
    border-radius: 4px;
    margin: 0.2rem 0 0.6rem;
    max-height: 22rem;
    overflow: auto;
    padding: 0.5rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  ol { padding-left: 1.2rem; }
  li { margin-bottom: 0.6rem; }
  .note { color: rgba(90, 90, 90, 1); font-size: 0.85rem; }
  #page-error:empty { display: none; }
  #page-error {
    background: rgba(200, 60, 60, 0.15);
    border-radius: 4px;
    padding: 0.4rem 0.6rem;
  }
`;
