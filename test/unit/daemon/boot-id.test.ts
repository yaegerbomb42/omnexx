import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBootId } from '../../../src/daemon/boot-id.js';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

const mockedReadFile = vi.mocked(readFile);
const originalPlatform = process.platform;

describe('readBootId', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    vi.resetAllMocks();
  });

  it('returns the trimmed boot id when the proc file has content', async () => {
    mockedReadFile.mockResolvedValue('  5f1d2c3e-9b8a-4f6d-8e7c-1a2b3c4d5e6f \n');
    await expect(readBootId()).resolves.toBe('5f1d2c3e-9b8a-4f6d-8e7c-1a2b3c4d5e6f');
  });

  it('returns unknown when the proc file is empty after trimming', async () => {
    mockedReadFile.mockResolvedValue('   \n');
    await expect(readBootId()).resolves.toBe('unknown');
    expect(mockedReadFile).toHaveBeenCalledWith('/proc/sys/kernel/random/boot_id', 'utf8');
  });

  it('returns unknown when reading the proc file fails', async () => {
    mockedReadFile.mockRejectedValue(new Error('EACCES'));
    await expect(readBootId()).resolves.toBe('unknown');
  });
});
