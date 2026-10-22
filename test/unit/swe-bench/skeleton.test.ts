import { describe, expect, it } from 'vitest';
import { buildSkeleton, renderSkeleton, renderSkeletons } from '../../../src/swe-bench/skeleton.js';

describe('skeleton', () => {
  describe('buildSkeleton', () => {
    it('extracts TypeScript declarations', () => {
      const code = `
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

export class Greeter {
  private name: string;
  
  constructor(name: string) {
    this.name = name;
  }
  
  greet(): string {
    return \`Hello, \${this.name}!\`;
  }
}

export interface Options {
  prefix?: string;
}
`;
      const skeleton = buildSkeleton('src/greet.ts', code);

      expect(skeleton.path).toBe('src/greet.ts');
      expect(skeleton.language).toBe('typescript');
      expect(skeleton.entries.length).toBeGreaterThan(0);

      const names = skeleton.entries.map((e) => e.name);
      expect(names).toContain('greet');
      expect(names).toContain('Greeter');
    });

    it('extracts Python declarations', () => {
      const code = `
def greet(name: str) -> str:
    return f"Hello, {name}!"

class Greeter:
    def __init__(self, name: str):
        self.name = name
    
    def greet(self) -> str:
        return f"Hello, {self.name}!"
`;
      const skeleton = buildSkeleton('src/greet.py', code);

      expect(skeleton.path).toBe('src/greet.py');
      expect(skeleton.language).toBe('python');
      expect(skeleton.entries.length).toBeGreaterThan(0);

      const names = skeleton.entries.map((e) => e.name);
      expect(names).toContain('greet');
      expect(names).toContain('Greeter');
    });

    it('handles empty files', () => {
      const skeleton = buildSkeleton('empty.ts', '');
      expect(skeleton.entries).toEqual([]);
    });

    it('handles unknown file types', () => {
      const skeleton = buildSkeleton('readme.txt', 'Hello world');
      expect(skeleton.language).toBe('unknown');
      expect(skeleton.entries).toEqual([]);
    });
  });

  describe('renderSkeleton', () => {
    it('renders a skeleton with entries', () => {
      const skeleton = buildSkeleton(
        'src/math.ts',
        `
export function add(a: number, b: number): number {
  return a + b;
}
`,
      );

      const rendered = renderSkeleton(skeleton);
      expect(rendered).toContain('src/math.ts');
      expect(rendered).toContain('typescript');
      expect(rendered).toContain('add');
    });

    it('renders skeleton without entries', () => {
      const skeleton = { path: 'empty.ts', language: 'typescript', entries: [] };
      const rendered = renderSkeleton(skeleton);
      expect(rendered).toContain('empty.ts');
      expect(rendered).toContain('no declarations found');
    });
  });

  describe('renderSkeletons', () => {
    it('renders multiple skeletons within token budget', () => {
      const skeletons = [
        buildSkeleton('a.ts', 'export function a() {}'),
        buildSkeleton('b.ts', 'export function b() {}'),
      ];

      const rendered = renderSkeletons(skeletons, 10000);
      expect(rendered).toContain('a.ts');
      expect(rendered).toContain('b.ts');
    });

    it('truncates when exceeding token budget', () => {
      const skeletons = [
        buildSkeleton('a.ts', 'export function a() {}'),
        buildSkeleton('b.ts', 'export function b() {}'),
      ];

      const rendered = renderSkeletons(skeletons, 50);
      expect(rendered).toBeTruthy();
    });
  });
});
