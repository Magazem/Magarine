import { GeneratedScreen } from './GeneratedScreen';
import type { GeneratedActionHandler } from './generated-actions';

export interface GeneratedPageProps { onAction: GeneratedActionHandler }

export function GeneratedPage({ onAction }: GeneratedPageProps) {
  return <GeneratedScreen onAction={onAction} />;
}
