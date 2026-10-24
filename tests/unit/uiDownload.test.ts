import { beforeEach, describe, expect, it, vi } from 'vitest';
import { approvedDownload } from '../../src/core/index.ts';
import type { Bundle } from '../../src/core/index.ts';
import type { Store } from '../../src/store/Store.ts';
import { downloadApproved } from '../../src/export/download.ts';

vi.mock('../../src/core/index.ts', () => ({ approvedDownload: vi.fn(), utf8Encode: vi.fn() }));

describe('M5 final download effect (authored, not run)', () => {
  beforeEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });
  it('does not create a Blob or click after an intake/auth generation changes during the approval recheck', async () => {
    let finish: (bytes: Uint8Array) => void = () => { throw new Error('not waiting'); };
    vi.mocked(approvedDownload).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const create = vi.fn(); vi.stubGlobal('URL', { createObjectURL: create });
    let current = true;
    const pending = downloadApproved({} as Store, 'm', {} as Bundle, 'agreement.md', () => current);
    current = false; finish(new Uint8Array([1, 2, 3]));
    await expect(pending).rejects.toThrow('Review changed');
    expect(create).not.toHaveBeenCalled();
  });
  it('never creates a download when the core rejects the gate/approval', async () => {
    vi.mocked(approvedDownload).mockRejectedValue(new Error('approval_required'));
    const create = vi.fn(); vi.stubGlobal('URL', { createObjectURL: create });
    await expect(downloadApproved({} as Store, 'm', {} as Bundle, 'agreement.docx')).rejects.toThrow('approval_required');
    expect(create).not.toHaveBeenCalled();
  });
});
