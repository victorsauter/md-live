/** Types shared by the Markdown parser and serializer. */
import type { Node as PMNode } from '@tiptap/pm/model';

/** Detected writing style of a document, used when new Markdown has to be generated. */
export interface DocStyle {
  bullet: string;
  emphasis: string;
  strong: string;
  fence: string;
  hr: string;
  hardBreak: string;
}

export const DEFAULT_STYLE: DocStyle = {
  bullet: '-',
  emphasis: '*',
  strong: '**',
  fence: '```',
  hr: '---',
  hardBreak: '\\',
};

/** A leaf of a textblock: a run of text, an inline code span or an inline atom. */
export interface Unit {
  /** Content offsets (relative to the start of the textblock content). */
  from: number;
  to: number;
  srcFrom: number;
  srcTo: number;
  kind: 'text' | 'code' | 'atom';
  /** Boundary map for text/code units (see `alignText`), `null` when unaligned. */
  map: number[] | null;
}

/** A point in a textblock where generated Markdown can be spliced without any open inline mark. */
export interface SplicePoint {
  pos: number;
  src: number;
}

/** Where a node came from in the original source. */
export interface Origin {
  sid: string;
  type: string;
  node: PMNode;
  start: number;
  end: number;
  /** Continuation prefix of lines 2..n of this node in the original source. */
  R: string;
  /** Container prefix of the children (blockquote, list item). */
  innerR: string;
  parent: Origin | null;
  index: number;
  // Textblocks.
  contentStart?: number;
  contentEnd?: number;
  units?: Unit[];
  points?: SplicePoint[];
  /** Whether the content starts at the beginning of a line (paragraph, setext heading). */
  contentAtLineStart?: boolean;
  // Lists and list items.
  indent?: number;
  head?: string;
  markerText?: string;
  numbering?: 'sequential' | 'same' | 'free';
  // Code blocks.
  openLine?: string;
  bodyLines?: Array<{ start: number; end: number }>;
  closeLine?: { start: number; end: number } | null;
  fenceIndent?: number;
  // Tables / rows / cells.
  delimLine?: string;
  cellCount?: number;
  emptyInsert?: number;
}

export interface Definition {
  url: string;
  title: string | null;
}

/** Everything the serializer needs to know about the source a document was parsed from. */
export interface SourceBase {
  text: string;
  origins: Map<string, Origin>;
  rootOrigins: Origin[];
  style: DocStyle;
  definitions: Map<string, Definition>;
}
