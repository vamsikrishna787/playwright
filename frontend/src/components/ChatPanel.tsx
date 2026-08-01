import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  /** Editor contents before this edit was applied, so it can be undone. */
  codeBefore?: string;
}

interface Props {
  scriptId: string;
  code: string;
  onApply: (code: string) => void;
}

const SUGGESTIONS = [
  'Add an assertion for the page title',
  'Make the locators more resilient',
  'Add a step that checks for a console error',
];

export default function ChatPanel({ scriptId, code, onApply }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  const send = async (instruction: string) => {
    const text = instruction.trim();
    if (!text || busy) return;

    setInput('');
    setError(null);
    setBusy(true);

    // Only the prose is replayed as history — the current file is always sent
    // fresh by the backend, so echoing old code back would just conflict.
    const history = messages.map(({ role, text: t }) => ({ role, text: t }));
    setMessages((prev) => [...prev, { role: 'user', text }]);

    try {
      const result = await api.enhance(scriptId, { instruction: text, code, history });
      const changed = result.code !== code;
      if (changed) onApply(result.code);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: result.reply,
          ...(changed ? { codeBefore: code } : {}),
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const undo = (index: number) => {
    const message = messages[index];
    if (message?.codeBefore === undefined) return;
    onApply(message.codeBefore);
    setMessages((prev) =>
      prev.map((m, i) => (i === index ? { ...m, codeBefore: undefined } : m)),
    );
  };

  return (
    <div className="chat">
      <div className="chat-log">
        {messages.length === 0 && !busy && (
          <div className="chat-empty">
            <p style={{ marginTop: 0 }}>
              Describe a change and the test is rewritten in place. The edit lands in the
              editor — nothing is saved until you click Save.
            </p>
            {SUGGESTIONS.map((s) => (
              <button key={s} className="chip" onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.text}
            {m.codeBefore !== undefined && (
              <button className="undo" onClick={() => undo(i)}>
                Undo this edit
              </button>
            )}
          </div>
        ))}

        {busy && (
          <div className="bubble assistant">
            <span className="spinner" />
            Rewriting the test…
          </div>
        )}

        {error && <div className="error-box">{error}</div>}
        <div ref={endRef} />
      </div>

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <textarea
          rows={2}
          placeholder="e.g. also verify the cart badge shows 1 after adding an item"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          disabled={busy}
        />
        <button className="primary" type="submit" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
