import { approvedDownload, utf8Encode } from '../core/index.ts';
import type { Bundle, BundleFilename } from '../core/index.ts';
import type { Store } from '../store/Store.ts';

const MIME: Readonly<Record<BundleFilename, string>> = {
  'agreement.md': 'text/markdown;charset=utf-8',
  'agreement.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'provenance.json': 'application/json;charset=utf-8',
  'bundle.json': 'application/json;charset=utf-8',
};

/** Copy the exact checked bytes. The object URL is local and revoked after the click completes. */
export function downloadBytes(bytes: Uint8Array, filename: string, mime: string): void {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const url = URL.createObjectURL(new Blob([copy.buffer], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  try { link.click(); } finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

/** Never offer agreement files through an unguarded Blob path. Re-gates and regenerates from Store. */
export async function downloadApproved(store: Store, matterId: string, bundle: Bundle, filename: BundleFilename, isCurrent: () => boolean = () => true): Promise<void> {
  const bytes = await approvedDownload(store, matterId, bundle, filename);
  if (!isCurrent()) throw new Error('Review changed before download completed.');
  downloadBytes(bytes, filename, MIME[filename]);
}

export function downloadStateJson(json: string): void {
  downloadBytes(utf8Encode(json), 'matter-state.json', MIME['provenance.json']);
}
