/**
 * One inline stylesheet. The page loads no external asset, so the Content Security Policy the route
 * sends can refuse every remote origin and the page renders the same way with no network beyond
 * this Worker.
 *
 * Two rules carry weight rather than taste. The transcript scrolls inside its own box, so a long
 * turn cannot push the composer off the screen. And below 52rem the sidebar leaves the flow
 * entirely, so a narrow window shows the conversation at full width; the toggle button puts the
 * project list back.
 */
export const OWNER_PAGE_STYLES = `
  :root { color-scheme: light dark; }
  body {
    font-family: ui-sans-serif, system-ui, sans-serif;
    margin: 0 auto;
    max-width: 78rem;
    padding: 1rem 1rem 2rem;
    line-height: 1.45;
  }
  h1 { font-size: 1.3rem; margin: 0 0 0.2rem; }
  h2 { font-size: 1.05rem; margin: 0 0 0.4rem; }
  h3 { font-size: 0.9rem; margin: 0.6rem 0 0.2rem; text-transform: uppercase; }
  #owner-layout { display: flex; align-items: flex-start; gap: 1rem; }
  #project-sidebar {
    border: 1px solid rgba(128, 128, 128, 0.4);
    border-radius: 6px;
    flex: 0 0 18rem;
    padding: 0.75rem;
  }
  #owner-layout.sidebar-collapsed #project-sidebar { display: none; }
  .sidebar-head { align-items: baseline; display: flex; gap: 0.5rem; justify-content: space-between; }
  .sidebar-panel { border-top: 1px solid rgba(128, 128, 128, 0.3); margin-top: 0.6rem; }
  #project-list { list-style: none; margin: 0.3rem 0; padding: 0; }
  #project-list li { margin: 0.2rem 0; }
  .project-button {
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    display: block;
    padding: 0.3rem 0.4rem;
    text-align: left;
    width: 100%;
  }
  .project-button.selected { border-color: rgba(90, 140, 220, 0.9); font-weight: 600; }
  .project-button .repo { color: rgba(90, 90, 90, 1); display: block; font-size: 0.75rem; }
  section {
    border: 1px solid rgba(128, 128, 128, 0.4);
    border-radius: 6px;
    margin-bottom: 0.75rem;
    padding: 0.6rem 0.8rem 0.8rem;
  }
  #conversation { flex: 1 1 auto; margin-bottom: 0; min-width: 0; }
  .generation-bar { margin-top: 0.5rem; }
  .drawer-panel { border-top: 1px solid rgba(128, 128, 128, 0.3); }
  .row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin: 0.3rem 0; }
  .field-label {
    color: rgba(90, 90, 90, 1);
    display: inline-block;
    font-size: 0.75rem;
    min-width: 9rem;
    text-transform: uppercase;
  }
  .value { font-family: ui-monospace, monospace; word-break: break-all; }
  input, textarea, button { font: inherit; }
  input, textarea { padding: 0.3rem 0.4rem; }
  input[type="text"] { min-width: 14rem; }
  input[type="number"] { width: 7rem; }
  textarea { box-sizing: border-box; width: 100%; }
  button { cursor: pointer; padding: 0.3rem 0.7rem; }
  button:disabled { cursor: default; opacity: 0.55; }
  :focus-visible { outline: 2px solid rgba(90, 140, 220, 0.9); outline-offset: 2px; }
  .messages {
    list-style: none;
    margin: 0.4rem 0;
    max-height: 60vh;
    overflow-y: auto;
    padding: 0;
  }
  .message { border-left: 3px solid rgba(128, 128, 128, 0.5); margin: 0.5rem 0; padding-left: 0.6rem; }
  .message.user { border-left-color: rgba(90, 140, 220, 0.9); }
  .message.terminal { border-left-color: rgba(120, 170, 120, 0.9); font-size: 0.85rem; }
  .message.terminal.problem { border-left-color: rgba(200, 60, 60, 0.9); }
  .message .who { color: rgba(90, 90, 90, 1); font-size: 0.75rem; text-transform: uppercase; }
  .message pre, .tool-output {
    background: rgba(128, 128, 128, 0.12);
    border-radius: 4px;
    margin: 0.2rem 0;
    max-height: 20rem;
    overflow: auto;
    padding: 0.4rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .message .text { background: none; padding: 0; }
  .tool-call { margin: 0.4rem 0; }
  .tool-call summary { cursor: pointer; font-family: ui-monospace, monospace; font-size: 0.85rem; }
  .tool-call.failed summary { color: rgba(200, 60, 60, 1); }
  .tool-output { font-family: ui-monospace, monospace; font-size: 0.8rem; }
  .diff-line { display: block; }
  .diff-line.added { background: rgba(80, 180, 80, 0.18); }
  .diff-line.removed { background: rgba(200, 60, 60, 0.18); }
  .diff-line.hunk { color: rgba(90, 120, 200, 1); }
  .composer { margin-top: 0.5rem; }
  .note { color: rgba(90, 90, 90, 1); font-size: 0.8rem; margin: 0.3rem 0; }
  #page-error:empty { display: none; }
  #page-error {
    background: rgba(200, 60, 60, 0.15);
    border-radius: 4px;
    padding: 0.4rem 0.6rem;
  }
  @media (max-width: 52rem) {
    #owner-layout { display: block; }
    #project-sidebar { margin-bottom: 0.75rem; width: auto; }
    .field-label { min-width: 7rem; }
  }
`;
