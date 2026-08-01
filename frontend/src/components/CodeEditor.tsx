import Editor from '@monaco-editor/react';

interface Props {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  height?: number;
}

export default function CodeEditor({ value, onChange, readOnly = false, height = 440 }: Props) {
  return (
    <div className="editor-shell">
      <Editor
        height={height}
        defaultLanguage="typescript"
        theme="vs-dark"
        value={value}
        onChange={(next) => onChange?.(next ?? '')}
        options={{
          readOnly,
          minimap: { enabled: false },
          fontSize: 13,
          scrollBeyondLastLine: false,
          padding: { top: 12, bottom: 12 },
          tabSize: 2,
          // The editor shares the row with the chat panel, so wrap rather than
          // pushing long locator chains off the right edge.
          wordWrap: 'on',
        }}
      />
    </div>
  );
}
