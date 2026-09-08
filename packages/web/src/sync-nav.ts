import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { committedToFull, fullToCommitted } from "@marginote/bridge/attribution";
import type * as Y from "yjs";
import { blockAt } from "./preview-blocks.js";

const flashLine = StateEffect.define<number | null>();
export const sourceFlash = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(flashLine)) {
        value = effect.value === null ? Decoration.none : Decoration.set([
          Decoration.line({ class: "sync-nav-flash" }).range(transaction.state.doc.lineAt(effect.value).from),
        ]);
      }
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function syncNavigation(
  preview: HTMLElement,
  active: () => { view: EditorView; text: Y.Text } | null,
): { schedule: () => void; reset: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let suppressedUntil = 0;
  let pointerDown = false;
  let flashed: HTMLElement | undefined;
  let blocks: Array<{ start: number; end: number; element: HTMLElement }> = [];
  let dirty = true;
  new MutationObserver(() => { dirty = true; }).observe(preview, { childList: true });
  const suppress = (): void => { suppressedUntil = Date.now() + 1000; };
  preview.addEventListener("wheel", suppress, { passive: true });
  preview.addEventListener("touchmove", suppress, { passive: true });
  preview.addEventListener("pointerdown", () => { pointerDown = true; suppress(); });
  window.addEventListener("pointerup", () => { pointerDown = false; });
  window.addEventListener("pointercancel", () => { pointerDown = false; });
  window.addEventListener("blur", () => { pointerDown = false; });
  preview.addEventListener("scroll", () => {
    if (pointerDown || Date.now() < suppressedUntil) suppress();
  }, { passive: true });
  preview.addEventListener("keydown", (event) => {
    if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key)) suppress();
  });

  preview.addEventListener("dblclick", (event) => {
    const context = active();
    const target = event.target instanceof Element ? event.target : null;
    if (!context || !target || target.closest("a, button, input, textarea, select, [role=button], .wikilink")) return;
    const block = target.closest<HTMLElement>("[data-src-start]");
    if (!block || !preview.contains(block)) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    const position = committedToFull(context.text, Number(block.dataset.srcStart));
    clearTimeout(flashTimer);
    context.view.dispatch({ effects: flashLine.of(null) });
    context.view.dom.getBoundingClientRect();
    context.view.dispatch({ selection: { anchor: position }, scrollIntoView: true, effects: flashLine.of(position) });
    context.view.focus();
    flashTimer = setTimeout(() => {
      if (active()?.view === context.view) context.view.dispatch({ effects: flashLine.of(null) });
    }, 1200);
  });

  return {
    schedule() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const context = active();
        if (!context || Date.now() < suppressedUntil) return;
        if (dirty) {
          blocks = [...preview.querySelectorAll<HTMLElement>(":scope > [data-src-start]")].map((element) => ({
            start: Number(element.dataset.srcStart), end: Number(element.dataset.srcEnd), element,
          })).filter((block, index, all) => index === 0 || block.start !== all[index - 1]!.start);
          dirty = false;
        }
        const block = blockAt(blocks, fullToCommitted(context.text, context.view.state.selection.main.head));
        if (!block) return;
        const viewport = preview.getBoundingClientRect();
        const bounds = block.element.getBoundingClientRect();
        // Partial visibility counts: a tall list must not jump on each keystroke.
        if (bounds.bottom <= viewport.top || bounds.top >= viewport.bottom) {
          preview.scrollTop += bounds.top - viewport.top - 24;
        }
        if (flashed === block.element) return;
        flashed?.classList.remove("sync-nav-flash");
        clearTimeout(previewTimer);
        flashed = block.element;
        flashed.classList.add("sync-nav-flash");
        previewTimer = setTimeout(() => {
          flashed?.classList.remove("sync-nav-flash");
          flashed = undefined;
        }, 1200);
      }, 150);
    },
    reset() {
      clearTimeout(timer);
      clearTimeout(flashTimer);
      clearTimeout(previewTimer);
      flashed?.classList.remove("sync-nav-flash");
      flashed = undefined;
      blocks = [];
      dirty = true;
      suppressedUntil = 0;
      pointerDown = false;
    },
  };
}
