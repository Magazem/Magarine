export type GeneratedActionId = 'layer-15' | 'layer-16' | 'layer-18' | 'layer-193' | 'layer-202' | 'layer-203' | 'layer-209' | 'layer-210' | 'layer-216' | 'layer-217' | 'layer-219' | 'layer-220' | 'layer-221' | 'layer-222' | 'layer-223' | 'layer-27' | 'layer-71' | 'layer-79' | 'layer-82' | 'layer-83' | 'layer-84' | 'layer-85' | 'layer-86' | 'layer-87' | 'layer-88' | 'layer-89' | 'layer-90';
export type GeneratedActionHandler = (actionId: GeneratedActionId) => void;

const GENERATED_ACTION_IDS = new Set<string>(['layer-15', 'layer-16', 'layer-18', 'layer-193', 'layer-202', 'layer-203', 'layer-209', 'layer-210', 'layer-216', 'layer-217', 'layer-219', 'layer-220', 'layer-221', 'layer-222', 'layer-223', 'layer-27', 'layer-71', 'layer-79', 'layer-82', 'layer-83', 'layer-84', 'layer-85', 'layer-86', 'layer-87', 'layer-88', 'layer-89', 'layer-90']);

export function resolveGeneratedAction(target: EventTarget | null): GeneratedActionId | null {
  const element = target instanceof Element ? target.closest('[data-action-id],[data-x]') : null;
  const layer = element?.getAttribute('data-x');
  const candidate = element?.getAttribute('data-action-id') ?? (layer === null ? null : 'layer-' + layer);
  return candidate && GENERATED_ACTION_IDS.has(candidate) ? candidate as GeneratedActionId : null;
}

export function dispatch12uiAction(actionId: GeneratedActionId, target: EventTarget = document): void {
  target.dispatchEvent(new CustomEvent('12ui:action', {
    detail: { actionId }, bubbles: true, composed: true,
  }));
}
