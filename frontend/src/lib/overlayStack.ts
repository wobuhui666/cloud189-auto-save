type OverlayKind = 'modal' | 'dialog';

interface OverlayEntry {
  id: number;
  kind: OverlayKind;
  onEscape: () => void;
  onEnter?: () => void;
}

let nextId = 1;
const stack: OverlayEntry[] = [];
let listening = false;

const handleKeyDown = (event: KeyboardEvent) => {
  const top = stack[stack.length - 1];
  if (!top) {
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    top.onEscape();
    return;
  }

  if (event.key === 'Enter' && top.onEnter) {
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName?.toLowerCase();
    if (tag === 'textarea' || tag === 'button' || target?.isContentEditable) {
      return;
    }
    event.preventDefault();
    top.onEnter();
  }
};

const ensureListener = () => {
  if (listening || typeof window === 'undefined') {
    return;
  }
  window.addEventListener('keydown', handleKeyDown);
  listening = true;
};

const maybeRemoveListener = () => {
  if (!listening || stack.length > 0 || typeof window === 'undefined') {
    return;
  }
  window.removeEventListener('keydown', handleKeyDown);
  listening = false;
};

export function pushOverlay(entry: Omit<OverlayEntry, 'id'>): number {
  const id = nextId++;
  stack.push({ ...entry, id });
  ensureListener();
  return id;
}

export function popOverlay(id: number) {
  const index = stack.findIndex((item) => item.id === id);
  if (index >= 0) {
    stack.splice(index, 1);
  }
  maybeRemoveListener();
}

export function updateOverlay(
  id: number,
  patch: Partial<Pick<OverlayEntry, 'onEscape' | 'onEnter'>>
) {
  const target = stack.find((item) => item.id === id);
  if (!target) {
    return;
  }
  if (patch.onEscape) {
    target.onEscape = patch.onEscape;
  }
  if (patch.onEnter !== undefined) {
    target.onEnter = patch.onEnter;
  }
}
