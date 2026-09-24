import type { ClassificationInput, ClassificationResult } from '../types/classification.types';

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

export interface LlmProvider {
  classify(input: ClassificationInput): Promise<ClassificationResult>;
}
