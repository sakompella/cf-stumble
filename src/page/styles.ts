/**
 * The transcript scrolls inside its own box so a long turn cannot push the composer off screen. Below
 * 52rem the sidebar leaves the flow; the toggle sits outside the collapsing panel so hiding the
 * projects never hides the control that shows them.
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
  .sidebar-column { display: flex; flex-direction: column; gap: 0.4rem; }
  #project-sidebar-toggle { align-self: flex-start; }
  #project-sidebar {
    border: 1px solid rgba(128, 128, 128, 0.4);
    border-radius: 6px;
    box-sizing: border-box;
    padding: 0.75rem;
    width: 18rem;
  }
  #owner-layout.sidebar-collapsed #project-sidebar { display: none; }
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
  .generation-bar { margin-top: 0.5rem; padding-bottom: 0.4rem; }
  .status-line { align-items: baseline; display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0 0 0.3rem; }
  .status-line button { margin-left: auto; }
  .generation-bar summary, .details summary { color: rgba(90, 90, 90, 1); cursor: pointer; font-size: 0.85rem; }
  .generation-bar > details { margin-top: 0.3rem; }
  .conversation-head { align-items: baseline; display: flex; gap: 0.6rem; }
  .drawer-panel { border-top: 1px solid rgba(128, 128, 128, 0.3); }
  .row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin: 0.3rem 0; }
  .field-label {
    color: rgba(90, 90, 90, 1);
    display: inline-block;
    font-size: 0.75rem;
    min-width: 6.5rem;
    text-transform: uppercase;
  }
  .value { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
  .row:has(> .value:empty) { display: none; }
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
  .build-output {
    background: rgba(128, 128, 128, 0.12);
    border-radius: 4px;
    max-height: 20rem;
    overflow: auto;
    padding: 0.4rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .message .text { background: none; font: inherit; padding: 0; }
  .markdown { overflow-wrap: anywhere; }
  .markdown > * { margin: 0.35rem 0; }
  .markdown p { white-space: pre-wrap; }
  .markdown h3, .markdown h4, .markdown h5, .markdown h6 { font-size: 1rem; text-transform: none; }
  .markdown ul, .markdown ol { padding-left: 1.4rem; }
  .markdown ul { list-style: disc; }
  .markdown ol { list-style: decimal; }
  .markdown code { font-family: ui-monospace, monospace; background: rgba(128, 128, 128, 0.18); border-radius: 3px; font-size: 0.9em; padding: 0 0.2rem; }
  .markdown pre { background: rgba(128, 128, 128, 0.12); border-radius: 4px; font-size: 0.85rem; overflow: auto; padding: 0.4rem; white-space: pre; }
  .markdown pre code { background: none; padding: 0; }
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
  .note:empty { display: none; }
  .status { font-family: ui-monospace, monospace; font-size: 0.85rem; }
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
