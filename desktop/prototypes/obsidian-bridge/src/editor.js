import { EditorState, EditorSelection } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  drawSelection,
} from "@codemirror/view";
import {
  history,
  historyKeymap,
  defaultKeymap,
  undo,
  redo,
  isolateHistory,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
export class Editor {
  constructor(parent, value, changed) {
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          drawSelection(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": "Compatibility Markdown editor",
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) changed(this.getValue());
          }),
        ],
      }),
    });
  }
  getValue() {
    return this.view.state.doc.toString();
  }
  setValue(text) {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      annotations: isolateHistory.of("full"),
    });
  }
  lineCount() {
    return this.view.state.doc.lines;
  }
  lastLine() {
    return this.lineCount() - 1;
  }
  getLine(line) {
    return this.view.state.doc.line(
      Math.max(1, Math.min(line + 1, this.lineCount())),
    ).text;
  }
  posToOffset(pos) {
    const line = this.view.state.doc.line(
      Math.max(1, Math.min(pos.line + 1, this.lineCount())),
    );
    return line.from + Math.max(0, Math.min(pos.ch, line.length));
  }
  offsetToPos(offset) {
    offset = Math.max(0, Math.min(offset, this.view.state.doc.length));
    const line = this.view.state.doc.lineAt(offset);
    return { line: line.number - 1, ch: offset - line.from };
  }
  getCursor(which = "head") {
    const s = this.view.state.selection.main;
    return this.offsetToPos(s[which] ?? s.head);
  }
  setCursor(pos) {
    this.setSelection(pos);
  }
  setSelection(anchor, head = anchor) {
    this.view.dispatch({
      selection: EditorSelection.single(
        this.posToOffset(anchor),
        this.posToOffset(head),
      ),
    });
  }
  listSelections() {
    return this.view.state.selection.ranges.map((r) => ({
      anchor: this.offsetToPos(r.anchor),
      head: this.offsetToPos(r.head),
    }));
  }
  getSelection() {
    const s = this.view.state.selection.main;
    return this.view.state.doc.sliceString(s.from, s.to);
  }
  getRange(from, to) {
    return this.view.state.doc.sliceString(
      this.posToOffset(from),
      this.posToOffset(to),
    );
  }
  replaceRange(text, from, to = from) {
    this.transaction({ changes: [{ from, to, text }] });
  }
  replaceSelection(text) {
    this.view.dispatch({ ...this.view.state.replaceSelection(text), annotations: isolateHistory.of("full") });
  }
  transaction(tx) {
    const changes = (tx.changes || [])
      .map((c) => ({
        from: this.posToOffset(c.from),
        to: this.posToOffset(c.to || c.from),
        insert: c.text,
      }))
      .sort((a, b) => a.from - b.from);
    const spec = { changes, annotations: isolateHistory.of("full") };
    if (tx.selection)
      spec.selection = EditorSelection.single(
        this.posToOffset(tx.selection.from),
        this.posToOffset(tx.selection.to || tx.selection.from),
      );
    this.view.dispatch(spec);
  }
  focus() {
    this.view.focus();
  }
  undo() {
    undo(this.view);
  }
  redo() {
    redo(this.view);
  }
  destroy() {
    this.view.destroy();
  }
}
