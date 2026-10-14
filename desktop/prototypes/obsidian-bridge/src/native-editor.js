import { EditorState, EditorSelection } from "@codemirror/state";
import { TextEditor } from "./editor.js";

// Obsidian's synchronous text API over a command-local buffer. No CodeMirror view is created.
// Only commit reaches the captured Amadeus instance, through its native transaction/history pipeline.
export class NativeEditor extends TextEditor {
  get cm() {
    return this.view;
  }
  getOption(name) {
    return name === "tabSize" ? 4 : undefined;
  }
  begin(edit) {
    if (this.active)
      throw new Error("Another Obsidian command is still running");
    if (!edit)
      throw new Error("Open an editable Amadeus note in visual mode first");
    this.edit = edit;
    this.selectionChanged = false;
    this.view = {
      state: EditorState.create({
        doc: edit.text,
        selection: EditorSelection.single(edit.anchor, edit.head),
      }),
      dispatch: (spec) => {
        if (!this.active) throw Error("Editor session ended");
        if (spec.selection) this.selectionChanged = true;
        this.view.state = this.view.state.update(spec).state;
      },
    };
    this.active = true;
  }
  setSelection(anchor, head = anchor) {
    this.selectionChanged = true;
    super.setSelection(anchor, head);
  }
  replaceSelection(text) {
    this.selectionChanged = true;
    super.replaceSelection(text);
  }
  transaction(tx) {
    if (tx.selection) this.selectionChanged = true;
    super.transaction(tx);
  }
  commit() {
    if (this.getValue() === this.edit.text && !this.selectionChanged) return;
    const s = this.view.state.selection.main;
    if (
      !this.edit.apply({
        text: this.getValue(),
        ...(this.selectionChanged
          ? { selection: { anchor: s.anchor, head: s.head } }
          : {}),
      })
    )
      throw new Error(
        "The native note or selection changed while the command ran. No plugin changes were applied.",
      );
  }
  end() {
    this.active = false;
    this.view = null;
    this.edit = null;
  }
  focus() {} // DOM/OS focus belongs to the host.
  destroy() {
    this.end();
  }
}
