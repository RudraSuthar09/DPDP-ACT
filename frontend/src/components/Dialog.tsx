'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

/**
 * App-wide modal dialogs — the Electron-native replacement for the browser's
 * window.confirm()/window.prompt(). Those are unsupported product UI in the
 * installed desktop app (Electron does not implement window.prompt at all, and
 * window.confirm/alert are jarring native popups), so every confirmation and
 * every text-input-before-an-action flow goes through these React dialogs
 * instead. Same provider shape as ToastProvider; one dialog is shown at a
 * time (these are always user-initiated, never concurrent).
 *
 * Usage:
 *   const { confirm, promptText } = useDialog();
 *   if (!(await confirm({ message: 'Remove this?', danger: true }))) return;
 *   const name = await promptText({ title: 'New form', label: 'Form name', required: true });
 *   if (name === null) return; // cancelled
 */

interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive (red) — for delete/remove/revoke. */
  danger?: boolean;
}

interface PromptOptions {
  title?: string;
  /** Explanatory text shown above the input. */
  message?: string;
  /** Label directly on the input. */
  label?: string;
  initialValue?: string;
  placeholder?: string;
  /** When true, the confirm button stays disabled until the field is non-empty. */
  required?: boolean;
  /** Render a textarea instead of a single-line input (for reasons/notes). */
  multiline?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
}

interface DialogApi {
  /** Resolves true if confirmed, false if cancelled/dismissed. */
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** Resolves the entered string, or null if cancelled/dismissed. */
  promptText(options: PromptOptions): Promise<string | null>;
}

type ActiveDialog =
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: 'prompt'; options: PromptOptions; resolve: (v: string | null) => void };

const DialogContext = createContext<DialogApi | null>(null);

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState<ActiveDialog | null>(null);
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => setActive({ kind: 'confirm', options, resolve }));
  }, []);

  const promptText = useCallback((options: PromptOptions) => {
    setInputValue(options.initialValue ?? '');
    return new Promise<string | null>((resolve) => setActive({ kind: 'prompt', options, resolve }));
  }, []);

  // Focus the input / primary control when a dialog opens.
  useEffect(() => {
    if (active?.kind === 'prompt') {
      // A tick later so the element is mounted.
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [active]);

  function close(result: boolean | string | null) {
    if (!active) return;
    if (active.kind === 'confirm') active.resolve(result as boolean);
    else active.resolve(result as string | null);
    setActive(null);
  }

  function onConfirm() {
    if (!active) return;
    if (active.kind === 'confirm') {
      close(true);
    } else {
      const trimmed = inputValue.trim();
      if (active.options.required && trimmed.length === 0) return;
      close(inputValue);
    }
  }

  function onCancel() {
    if (!active) return;
    close(active.kind === 'confirm' ? false : null);
  }

  const promptDisabled =
    active?.kind === 'prompt' && !!active.options.required && inputValue.trim().length === 0;

  return (
    <DialogContext.Provider value={{ confirm, promptText }}>
      {children}
      {active && (
        <div
          className="modal-overlay"
          role="presentation"
          onMouseDown={(e) => {
            // Click on the backdrop (not the card) cancels.
            if (e.target === e.currentTarget) onCancel();
          }}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-label={active.options.title ?? (active.kind === 'confirm' ? 'Confirm' : 'Input required')}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onCancel();
              }
            }}
          >
            {active.options.title && <h2 className="modal-title">{active.options.title}</h2>}

            {active.kind === 'confirm' && <p className="modal-message">{active.options.message}</p>}

            {active.kind === 'prompt' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  onConfirm();
                }}
              >
                {active.options.message && <p className="modal-message">{active.options.message}</p>}
                {active.options.label && <label htmlFor="dpdp-dialog-input">{active.options.label}</label>}
                {active.options.multiline ? (
                  <textarea
                    id="dpdp-dialog-input"
                    ref={(el) => {
                      inputRef.current = el;
                    }}
                    rows={4}
                    value={inputValue}
                    placeholder={active.options.placeholder}
                    onChange={(e) => setInputValue(e.target.value)}
                  />
                ) : (
                  <input
                    id="dpdp-dialog-input"
                    ref={(el) => {
                      inputRef.current = el;
                    }}
                    value={inputValue}
                    placeholder={active.options.placeholder}
                    onChange={(e) => setInputValue(e.target.value)}
                  />
                )}
              </form>
            )}

            <div className="modal-actions">
              <button type="button" onClick={onCancel}>
                {active.options.cancelLabel ?? 'Cancel'}
              </button>
              <button
                type="button"
                className={active.kind === 'confirm' && active.options.danger ? 'danger' : 'primary'}
                disabled={promptDisabled}
                onClick={onConfirm}
              >
                {active.options.confirmLabel ?? (active.kind === 'confirm' ? 'Confirm' : 'OK')}
              </button>
            </div>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  );
}

export function useDialog(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialog must be used within DialogProvider');
  return ctx;
}
