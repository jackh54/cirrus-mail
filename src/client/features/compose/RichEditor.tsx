import { useEditor, EditorContent, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Bold, Code, Italic, Link2, List, ListOrdered, Quote, RemoveFormatting, Underline } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface Props {
  initialHtml: string;
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
  autofocus?: boolean;
  /** Ref callback to reach the editor (e.g. to focus it). */
  onReady?: (e: Editor) => void;
  toolbarPosition?: 'top' | 'bottom';
}

/** TipTap editor with the compose toolbar. StarterKit v3 ships Link and Underline already. */
export function RichEditor({ initialHtml, onChange, placeholder, className, autofocus, onReady, toolbarPosition = 'bottom' }: Props) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' } },
      }),
      Placeholder.configure({ placeholder: placeholder ?? 'Write your message…' }),
    ],
    content: initialHtml,
    autofocus: autofocus ? 'start' : false,
    editorProps: { attributes: { class: 'cm-prose min-h-40 px-4 py-3', 'aria-label': 'Message body', role: 'textbox', 'aria-multiline': 'true' } },
    onCreate: ({ editor: e }) => onReady?.(e),
    onUpdate: ({ editor: e }) => onChange(e.getHTML()),
  });

  const toolbar = editor ? <Toolbar editor={editor} /> : null;
  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      {toolbarPosition === 'top' && toolbar}
      <EditorContent editor={editor} className="min-h-0 flex-1 overflow-y-auto" />
      {toolbarPosition === 'bottom' && toolbar}
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      quote: e.isActive('blockquote'),
      code: e.isActive('code'),
      link: e.isActive('link'),
    }),
  });

  const setLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Link URL', prev ?? 'https://');
    if (url === null) return;
    if (!url.trim()) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    const href = /^(https?:|mailto:)/i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
  };

  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-px px-3 py-1">
      <Tool label="Bold" active={s.bold} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={15} /></Tool>
      <Tool label="Italic" active={s.italic} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={15} /></Tool>
      <Tool label="Underline" active={s.underline} onClick={() => editor.chain().focus().toggleUnderline().run()}><Underline size={15} /></Tool>
      <Sep />
      <Tool label="Bulleted list" active={s.bullet} onClick={() => editor.chain().focus().toggleBulletList().run()}><List size={15} /></Tool>
      <Tool label="Numbered list" active={s.ordered} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered size={15} /></Tool>
      <Tool label="Quote" active={s.quote} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote size={15} /></Tool>
      <Sep />
      <Tool label="Link" active={s.link} onClick={setLink}><Link2 size={15} /></Tool>
      <Tool label="Code" active={s.code} onClick={() => editor.chain().focus().toggleCode().run()}><Code size={15} /></Tool>
      <Tool label="Clear formatting" onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}>
        <RemoveFormatting size={15} />
      </Tool>
    </div>
  );
}

function Tool({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      data-tip={label}
      data-tip-side="top"
      aria-pressed={active ?? undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        'cm-tip inline-flex size-7 items-center justify-center rounded-md transition-colors duration-100 [&_svg]:stroke-[1.75]',
        active ? 'bg-hover text-fg' : 'text-faint hover:bg-hover hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <span className="mx-1 h-3.5 w-px bg-border" aria-hidden="true" />;
}
