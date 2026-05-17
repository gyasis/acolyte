import type { CustomPersona } from '../types.js';
import { teacher } from './teacher.js';
import { docs }    from './docs.js';
import { business } from './business.js';
import { bare }    from './bare.js';

export const personas: Record<string, CustomPersona> = {
  teacher,
  docs,
  business,
  bare
};

export { teacher, docs, business, bare };
