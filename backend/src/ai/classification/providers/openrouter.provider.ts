import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildInvestorClassificationPrompt } from '../prompts/investor-classification.prompt';
import { parseClassificationResult } from '../schemas/classification.schema';
import type { ClassificationInput, ClassificationResult } from '../types/classification.types';
import type { LlmProvider } from './llm-provider.interface';

@Injectable()
export class OpenRouterProvider implements LlmProvider {
  private readonly logger = new Logger(OpenRouterProvider.name);

  constructor(private readonly config: ConfigService) {}

  async classify(input: ClassificationInput): Promise<ClassificationResult> {
    const apiKey = this.config.get<string>('openRouter.apiKey');
    const model = this.config.get<string>('openRouter.model');
    const baseUrl = this.config.get<string>('openRouter.baseUrl', 'https://openrouter.ai/api/v1');
    const timeoutMs = this.config.get<number>('openRouter.timeoutMs', 20000);
    const retries = this.config.get<number>('openRouter.retries', 2);
    if (!apiKey || !model) throw new Error('OpenRouter is not configured');

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: 'Return only valid JSON matching the requested classification schema.' },
              { role: 'user', content: buildInvestorClassificationPrompt(input) },
            ],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          const error = new Error(`OpenRouter request failed with status ${response.status}`);
          if (response.status < 500 && response.status !== 429) throw error;
          throw error;
        }
        const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
        const content = payload.choices?.[0]?.message?.content;
        if (!content) throw new Error('OpenRouter returned an empty response');
        const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        return parseClassificationResult(JSON.parse(cleaned));
      } catch (error) {
        lastError = error;
        if (attempt < retries) continue;
      }
    }
    this.logger.warn('OpenRouter classification failed after retries');
    throw lastError instanceof Error ? lastError : new Error('OpenRouter classification failed');
  }
}
