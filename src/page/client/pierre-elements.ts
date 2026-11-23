import { PIERRE_SCRIPT_PATH } from "../pierre-script.generated.js";
import { DiffView, MarkdownView } from "./pierre-views.js";
import type * as Pierre from "./pierre/entry.js";

function pierre(): Promise<typeof Pierre> {
  return import(PIERRE_SCRIPT_PATH);
}

class MarkdownElement extends HTMLElement {
  #source = "";
  #isStreaming = false;
  #view: Pierre.MarkdownView | undefined;
  #isLoading = false;

  get source(): string {
    return this.#source;
  }

  set source(value: string) {
    this.#source = value;
    this.#render();
  }

  get streaming(): boolean {
    return this.#isStreaming;
  }

  set streaming(value: boolean) {
    this.#isStreaming = value;
    this.#render();
  }

  connectedCallback(): void {
    this.#render();
  }

  #render(): void {
    if (!this.isConnected) {
      return;
    }

    if (this.#view !== undefined) {
      this.#view.update(this.#source, this.#isStreaming);

      return;
    }

    this.textContent = this.#source;

    if (this.#isLoading) {
      return;
    }

    this.#isLoading = true;
    void pierre().then(({ mountMarkdown }) => {
      this.#view = mountMarkdown(this);
      this.#render();
    });
  }
}

class DiffElement extends HTMLElement {
  #patch = "";
  #shownPatch = "";

  get patch(): string {
    return this.#patch;
  }

  set patch(value: string) {
    this.#patch = value;
    this.#render();
  }

  connectedCallback(): void {
    this.#render();
  }

  #show(patch: string, rendered: Pierre.RenderedDiff | undefined): void {
    if (patch !== this.#patch || (rendered === undefined && this.shadowRoot === null)) {
      return;
    }

    const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });

    shadow.adoptedStyleSheets = [...(rendered?.sheets ?? [])];
    shadow.innerHTML = rendered?.html ?? "<slot></slot>";
  }

  #render(): void {
    const patch = this.#patch;

    if (!this.isConnected || patch === this.#shownPatch) {
      return;
    }

    this.#shownPatch = patch;
    void pierre()
      .then(({ renderDiff }) => renderDiff(patch))
      .then((rendered) => {
        this.#show(patch, rendered);
      });
  }
}

export function defineRendererElements(): void {
  customElements.define(MarkdownView.tag, MarkdownElement);
  customElements.define(DiffView.tag, DiffElement);
}
