'use client';

import { useCallback, useRef, useState } from 'react';
import { ACCEPTED_TYPES } from '@/lib/decode';
import { classNames } from '@/lib/format';

interface DropzoneProps {
  onFile: (file: File) => void;
  disabled?: boolean;
  compact?: boolean;
}

export function Dropzone({ onFile, disabled, compact }: DropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // A drag over a child element fires dragleave on the parent, so a plain boolean
  // flickers. Counting enter/leave pairs is what keeps the highlight stable.
  const dragDepth = useRef(0);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (disabled) return;

      const file = event.dataTransfer.files?.[0];
      if (file) onFile(file);
    },
    [disabled, onFile]
  );

  return (
    <div
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepth.current += 1;
        if (!disabled) setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={handleDrop}
      className={classNames(
        'relative rounded-2xl border-2 border-dashed transition-colors',
        compact ? 'p-6' : 'p-10 sm:p-14',
        dragging
          ? 'border-accent bg-accent/10'
          : 'border-ink-600 bg-ink-900/60 hover:border-ink-500',
        disabled && 'pointer-events-none opacity-60'
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_TYPES.join(',')}
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
          // Reset so selecting the same file twice still fires a change event.
          event.target.value = '';
        }}
      />

      <div className="flex flex-col items-center gap-3 text-center">
        <div
          className={classNames(
            'flex h-12 w-12 items-center justify-center rounded-xl border transition-colors',
            dragging ? 'border-accent text-accent' : 'border-ink-600 text-ink-300'
          )}
          aria-hidden="true"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6">
            <path
              d="M12 16V4m0 0L8 8m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        <div>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-ink-950 transition-colors hover:bg-accent-bright"
          >
            Choose an image
          </button>
          <p className="mt-3 text-sm text-ink-300">
            or drop a PNG or JPG here
          </p>
        </div>

        {!compact && (
          <p className="mt-1 max-w-sm text-xs text-ink-400">
            Converted entirely in your browser. The file is never uploaded.
          </p>
        )}
      </div>
    </div>
  );
}
