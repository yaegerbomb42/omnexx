export type FieldType = 'string' | 'integer' | 'boolean' | 'string[]' | 'enum';

export interface Field {
  type: FieldType;
  required?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  values?: readonly string[];
}

/** Dotted path -> field. Every config key is one of these. */
export const SCHEMA: Readonly<Record<string, Field>> = {
  'server.port': { type: 'integer', min: 1, max: 65535, default: 8080 },
  'server.host': { type: 'string', default: '127.0.0.1' },
  'log.level': { type: 'enum', values: ['debug', 'info', 'warn', 'error'], default: 'info' },
  'log.json': { type: 'boolean', default: false },
  'db.url': { type: 'string', required: true },
  'db.poolSize': { type: 'integer', min: 1, max: 100, default: 10 },
  features: { type: 'string[]', default: [] },
};
