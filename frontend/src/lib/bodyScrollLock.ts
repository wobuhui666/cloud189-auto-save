let lockCount = 0;
let previousBodyOverflow = '';
let previousScrollableOverflow = '';
let lockedScrollable: HTMLElement | null = null;

function getMainScrollable(): HTMLElement | null {
  if (typeof document === 'undefined') {
    return null;
  }
  return document.querySelector('.content-scrollable') as HTMLElement | null;
}

export function lockBodyScroll() {
  if (typeof document === 'undefined') {
    return;
  }

  if (lockCount === 0) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const scrollable = getMainScrollable();
    if (scrollable) {
      lockedScrollable = scrollable;
      previousScrollableOverflow = scrollable.style.overflow;
      scrollable.style.overflow = 'hidden';
    } else {
      lockedScrollable = null;
      previousScrollableOverflow = '';
    }
  }

  lockCount += 1;
}

export function unlockBodyScroll() {
  if (typeof document === 'undefined') {
    return;
  }

  if (lockCount === 0) {
    return;
  }

  lockCount -= 1;

  if (lockCount === 0) {
    document.body.style.overflow = previousBodyOverflow;
    previousBodyOverflow = '';

    if (lockedScrollable) {
      lockedScrollable.style.overflow = previousScrollableOverflow;
      lockedScrollable = null;
      previousScrollableOverflow = '';
    }
  }
}
