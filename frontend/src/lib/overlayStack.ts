type OverlayKind = 'modal' | 'dialog' | 'drawer';

interface OverlayEntry {
  id: number;
  kind: OverlayKind;
  onEscape: () => void;
  onEnter?: () => void;
}

let nextId = 1;
const stack: OverlayEntry[] = [];
let listening = false;

/** Base z-index for stack layers (backdrop = base + index*10, panel = +1) */
const Z_BASE: Record<OverlayKind, number> = {
  drawer: 150,
  modal: 200,
  dialog: 400,
};

const handleKeyDown = (event: KeyboardEvent) => {
  const top = stack[stack.length - 1];
  if (!top) {
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
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
  // capture phase so we win over App-level document listeners
  window.addEventListener('keydown', handleKeyDown, true);
  listening = true;
};

const maybeRemoveListener = () => {
  if (!listening || stack.length > 0 || typeof window === 'undefined') {
    return;
  }
  window.removeEventListener('keydown', handleKeyDown, true);
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

/** Stack depth of this overlay (0-based among same/all); used for z-index stacking */
export function getOverlayDepth(id: number): number {
  return stack.findIndex((item) => item.id === id);
}

export function getOverlayZIndex(id: number, kind: OverlayKind = 'modal'): { backdrop: number; panel: number } {
  const depth = Math.max(0, getOverlayDepth(id));
  // each nested layer +10 so later modals sit above earlier ones
  const base = Z_BASE[kind] + depth * 10;
  return { backdrop: base, panel: base + 1 };
}

export function getStackSize(): number {
  return stack.length;
}
