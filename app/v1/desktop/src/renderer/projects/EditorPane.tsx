import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor/editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import 'monaco-editor/languages/definitions/typescript/register'
import 'monaco-editor/languages/definitions/javascript/register'
import 'monaco-editor/languages/definitions/css/register'
import 'monaco-editor/languages/definitions/html/register'
import 'monaco-editor/languages/definitions/markdown/register'
import 'monaco-editor/languages/definitions/python/register'
import type { FileText } from '../../shared/projects.js'

;(globalThis as typeof globalThis & { MonacoEnvironment: { getWorker(): Worker } }).MonacoEnvironment = { getWorker: () => new EditorWorker() }
function language(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  return ({ ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', css: 'css', html: 'html', md: 'markdown', py: 'python', json: 'json' } as Record<string, string>)[ext ?? ''] ?? 'plaintext'
}
export function EditorPane({ file, onChange, onSave }: { file: FileText; onChange(text: string): void; onSave(): void }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null), model = useRef<monaco.editor.ITextModel | null>(null), change = useRef(onChange), save = useRef(onSave)
  change.current = onChange; save.current = onSave
  useEffect(() => {
    const text = monaco.editor.createModel(file.text, language(file.path)); model.current = text
    const editor = monaco.editor.create(host.current!, { model: text, theme: 'vs-dark', automaticLayout: true, editContext: false, fontSize: 13, fontFamily: 'Cascadia Code, Consolas, monospace', minimap: { enabled: false }, padding: { top: 14 }, scrollBeyondLastLine: false })
    const listener = text.onDidChangeContent(() => change.current(text.getValue()))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save.current())
    return () => { listener.dispose(); editor.dispose(); text.dispose(); model.current = null }
  }, [file.path])
  // Only disk revisions replace the model. Echoing every onChange value back
  // through a React effect can overwrite a newer keystroke during fast input.
  useEffect(() => { const text = model.current; if (text && text.getValue() !== file.text) text.setValue(file.text) }, [file.revision])
  return <div ref={host} className="project-editor" data-project-tool="editor" />
}
