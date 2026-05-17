import type { CustomPersona } from '../types.js';

/**
 * Minimal persona — no role-play, no specialization, just the LLM with
 * page-RAG attached. Use as a starting point for custom personas.
 */
export const bare: CustomPersona = {
  role:
    'You are a helpful AI assistant. The user is looking at a page; relevant passages from it are provided as context when available. Answer clearly using the context when it helps, your own knowledge otherwise.',
  tone: 'concise',
  speakStyle: 'verbatim',
  grounding: 'permissive',
  refusalPolicy: 'answer'
};
