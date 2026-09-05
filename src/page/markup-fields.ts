/**
 * The two shapes every panel on this page is built from: a labelled value a reader observes, and a
 * labelled control row. Keeping them here means the sidebar, the conversation, and the generation
 * drawer render the same way without a template engine or a build step.
 */

/** A labelled read-only value. The element with `id` holds only the value a test must read. */
export function value(label: string, id: string): string {
  return `<div class="row"><span class="field-label">${label}</span><span class="value" id="${id}"></span></div>`;
}

/** A labelled single-line input followed by the button that acts on it. */
export function control(input: {
  readonly label: string;
  readonly inputId: string;
  readonly inputType: string;
  readonly buttonId: string;
  readonly buttonText: string;
}): string {
  const attributes =
    input.inputType === "number"
      ? `type="number" min="0" step="1"`
      : `type="text" autocomplete="off" spellcheck="false"`;
  return `<div class="row">
        <label class="field-label" for="${input.inputId}">${input.label}</label>
        <input id="${input.inputId}" ${attributes} />
        <button id="${input.buttonId}" type="button">${input.buttonText}</button>
      </div>`;
}
